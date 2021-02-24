import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as kms from '@aws-cdk/aws-kms';
import * as s3 from '@aws-cdk/aws-s3';
import { RegionInfo } from '@aws-cdk/region-info';
import { EbsDefaultEncryption } from '@aws-accelerator/custom-resource-ec2-ebs-default-encryption';
import { S3CopyFiles } from '@aws-accelerator/custom-resource-s3-copy-files';
import { S3PublicAccessBlock } from '@aws-accelerator/custom-resource-s3-public-access-block';
import { Organizations } from '@aws-accelerator/custom-resource-organization';
import { AcceleratorConfig } from '@aws-accelerator/common-config/src';
import {
  createEncryptionKeyName,
  createRoleName,
} from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
import { CfnLogBucketOutput, CfnAesBucketOutput, CfnCentralBucketOutput, CfnEbsKmsOutput } from './outputs';
import { AccountStacks } from '../../common/account-stacks';
import { Account } from '../../utils/accounts';
import { createDefaultS3Bucket, createDefaultS3Key } from './shared';
import { overrideLogicalId } from '../../utils/cdk';
import { getVpcSharedAccountKeys } from '../../common/vpc-subnet-sharing';

export type AccountRegionEbsEncryptionKeys = { [accountKey: string]: { [region: string]: kms.Key } | undefined };

export interface DefaultsStep1Props {
  acceleratorPrefix: string;
  accountStacks: AccountStacks;
  accounts: Account[];
  config: AcceleratorConfig;
}

export interface DefaultsStep1Result {
  centralBucketCopy: s3.Bucket;
  centralLogBucket: s3.Bucket;
  aesLogBucket?: s3.Bucket;
  accountEbsEncryptionKeys: AccountRegionEbsEncryptionKeys;
}

export async function step1(props: DefaultsStep1Props): Promise<DefaultsStep1Result> {
  blockS3PublicAccess(props);

  const centralBucketCopy = createCentralBucketCopy(props);
  const centralLogBucket = createCentralLogBucket(props);
  const accountEbsEncryptionKeys = createDefaultEbsEncryptionKey(props);
  const aesLogBucket = createAesLogBucket(props);
  return {
    centralBucketCopy,
    centralLogBucket,
    aesLogBucket,
    accountEbsEncryptionKeys,
  };
}

function blockS3PublicAccess(props: DefaultsStep1Props) {
  const { accountStacks, config } = props;

  for (const [accountKey, accountConfig] of config.getAccountConfigs()) {
    const accountStack = accountStacks.tryGetOrCreateAccountStack(accountKey);
    if (!accountStack) {
      console.warn(`Cannot find account stack ${accountKey}`);
      continue;
    }

    const blockPublicAccess = !accountConfig['enable-s3-public-access'];
    new S3PublicAccessBlock(accountStack, 'PublicAccessBlock', {
      blockPublicAcls: blockPublicAccess,
      blockPublicPolicy: blockPublicAccess,
      ignorePublicAcls: blockPublicAccess,
      restrictPublicBuckets: blockPublicAccess,
    });
  }
}

/**
 * Creates a bucket that contains copies of the files in the central bucket.
 */
function createCentralBucketCopy(props: DefaultsStep1Props) {
  const { accountStacks, config } = props;

  const masterAccountConfig = config['global-options']['aws-org-master'];
  const masterAccountStack = accountStacks.getOrCreateAccountStack(masterAccountConfig.account);

  const organizations = new Organizations(masterAccountStack, 'Organizations');

  const keyAlias = createEncryptionKeyName('Config-Key');
  const encryptionKey = new kms.Key(masterAccountStack, 'CentralBucketKey', {
    alias: `alias/${keyAlias}`,
    description: 'Key used to encrypt/decrypt the copy of central S3 bucket',
    enableKeyRotation: true,
  });

  const bucket = new s3.Bucket(masterAccountStack, 'CentralBucketCopy', {
    encryptionKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // TODO: Remove and use fields directly when CDK enhanced s3.Bucket.
  (bucket.node.defaultChild as s3.CfnBucket).addPropertyOverride('OwnershipControls', {
    Rules: [
      {
        ObjectOwnership: 'BucketOwnerPreferred',
      },
    ],
  });

  // Let the bucket name be generated by CloudFormation
  // The generated bucket name is based on the stack name + logical ID + random suffix
  overrideLogicalId(bucket, `config${masterAccountStack.region}`);

  const anyAccountPrincipal = [new iam.AnyPrincipal()];

  // Give all accounts access to use this key for decryption
  encryptionKey.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      principals: anyAccountPrincipal,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
      },
    }),
  );

  // Give all accounts access to get and list objects in this bucket
  bucket.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ['s3:Get*', 's3:List*'],
      resources: [bucket.bucketArn, bucket.arnForObjects('*')],
      principals: anyAccountPrincipal,
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
      },
    }),
  );

  new CfnCentralBucketOutput(masterAccountStack, 'CentralBucketOutput', {
    bucketArn: bucket.bucketArn,
    bucketName: bucket.bucketName,
    encryptionKeyArn: encryptionKey.keyArn,
    region: cdk.Aws.REGION,
    encryptionKeyId: encryptionKey.keyId,
    encryptionKeyName: keyAlias,
  });

  return bucket;
}

/**
 * Creates a bucket that contains copies of the files in the central bucket.
 */
function createCentralLogBucket(props: DefaultsStep1Props) {
  const { accountStacks, config } = props;

  const logAccountConfig = config['global-options']['central-log-services'];
  const logAccountStack = accountStacks.getOrCreateAccountStack(logAccountConfig.account);

  const organizations = new Organizations(logAccountStack, 'Organizations');

  const anyAccountPrincipal = [new iam.AnyPrincipal()];
  const logKey = createDefaultS3Key({
    accountStack: logAccountStack,
  });

  const defaultLogRetention = config['global-options']['central-log-services']['s3-retention'];

  const logBucket = createDefaultS3Bucket({
    accountStack: logAccountStack,
    encryptionKey: logKey.encryptionKey,
    logRetention: defaultLogRetention!,
    versioned: true,
  });

  // Allow replication from all Accelerator accounts
  logBucket.replicateFrom(anyAccountPrincipal, organizations.organizationId, props.acceleratorPrefix);

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: anyAccountPrincipal,
      actions: ['s3:GetEncryptionConfiguration', 's3:PutObject'],
      resources: [logBucket.bucketArn, logBucket.arnForObjects('*')],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
      },
    }),
  );

  // Allow Kinesis access bucket
  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: anyAccountPrincipal,
      actions: [
        's3:AbortMultipartUpload',
        's3:GetBucketLocation',
        's3:GetObject',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:PutObject',
        's3:PutObjectAcl',
      ],
      resources: [logBucket.bucketArn, `${logBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
        ArnLike: {
          'aws:PrincipalARN': `arn:aws:iam::*:role/${props.acceleratorPrefix}Kinesis-*`,
        },
      },
    }),
  );

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [
        new iam.ServicePrincipal('delivery.logs.amazonaws.com'),
        new iam.ServicePrincipal('cloudtrail.amazonaws.com'),
        new iam.ServicePrincipal('config.amazonaws.com'),
      ],
      actions: ['s3:PutObject'],
      resources: [`${logBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
      },
    }),
  );

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [
        new iam.ServicePrincipal('delivery.logs.amazonaws.com'),
        new iam.ServicePrincipal('cloudtrail.amazonaws.com'),
        new iam.ServicePrincipal('config.amazonaws.com'),
      ],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [`${logBucket.bucketArn}`],
    }),
  );

  // Permission to allow checking existence of AWSConfig bucket
  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('config.amazonaws.com')],
      actions: ['s3:ListBucket'],
      resources: [`${logBucket.bucketArn}`],
    }),
  );

  // Allow cross account encrypt access for logArchive bucket
  logBucket.encryptionKey?.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'Enable cross account encrypt access for S3 Cross Region Replication',
      actions: ['kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      principals: anyAccountPrincipal,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
      },
    }),
  );

  new CfnLogBucketOutput(logAccountStack, 'LogBucketOutput', {
    bucketArn: logBucket.bucketArn,
    bucketName: logBucket.bucketName,
    encryptionKeyArn: logBucket.encryptionKey!.keyArn,
    region: cdk.Aws.REGION,
    encryptionKeyId: logBucket.encryptionKey!.keyId,
    encryptionKeyName: logKey.alias,
  });

  logBucket.encryptionKey?.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'Allow CloudTrail to encrypt and describe logs',
      actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      resources: ['*'],
    }),
  );

  return logBucket;
}

/**
 * Creates a bucket that will be used to store ALB access logs.
 */
function createAesLogBucket(props: DefaultsStep1Props) {
  const { accountStacks, config } = props;

  const logAccountConfig = config['global-options']['central-log-services'];
  const logAccountStack = accountStacks.getOrCreateAccountStack(logAccountConfig.account);

  const regionInfo = RegionInfo.get(logAccountStack.region);
  const elbv2Account = regionInfo?.elbv2Account;
  if (!elbv2Account) {
    console.warn(`Cannot enable access logging; don't know ELBv2 account for region ${logAccountConfig.region}`);
    return;
  }

  const logBucket = new s3.Bucket(logAccountStack, 'AesBucket', {
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // TODO: Remove and use fields directly when CDK enhanced s3.Bucket.
  (logBucket.node.defaultChild as s3.CfnBucket).addPropertyOverride('OwnershipControls', {
    Rules: [
      {
        ObjectOwnership: 'BucketOwnerPreferred',
      },
    ],
  });

  // Let the bucket name be generated by CloudFormation
  // The generated bucket name is based on the stack name + logical ID + random suffix
  overrideLogicalId(logBucket, `aes${logAccountStack.region}`);

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.AccountPrincipal(elbv2Account)],
      actions: ['s3:PutObject'],
      resources: [`${logBucket.bucketArn}/*`],
    }),
  );

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${logBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
      },
    }),
  );

  logBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [`${logBucket.bucketArn}`],
    }),
  );

  new CfnAesBucketOutput(logAccountStack, 'AesLogBucketOutput', {
    bucketArn: logBucket.bucketArn,
    bucketName: logBucket.bucketName,
    region: cdk.Aws.REGION,
  });

  return logBucket;
}

function createDefaultEbsEncryptionKey(props: DefaultsStep1Props): AccountRegionEbsEncryptionKeys {
  const { accountStacks, config, accounts } = props;

  // Create an EBS encryption key for every account and region that has a VPC
  const accountEbsEncryptionKeys: AccountRegionEbsEncryptionKeys = {};
  for (const { accountKey, vpcConfig, ouKey } of config.getVpcConfigs()) {
    const region = vpcConfig.region;
    const vpcSharedTo = getVpcSharedAccountKeys(accounts, vpcConfig, ouKey);
    vpcSharedTo.push(accountKey);
    const accountKeys = Array.from(new Set(vpcSharedTo));
    for (const localAccountKey of accountKeys) {
      if (accountEbsEncryptionKeys[localAccountKey]?.[region]) {
        console.log(`EBSEncryptionKey is already created in account ${localAccountKey} and region ${region}`);
        continue;
      }

      const accountStack = accountStacks.tryGetOrCreateAccountStack(localAccountKey, region);
      if (!accountStack) {
        console.warn(`Cannot find account stack ${localAccountKey}`);
        continue;
      }

      const keyAlias = createEncryptionKeyName('EBS-Key');
      // Default EBS encryption key
      const key = new kms.Key(accountStack, 'EbsDefaultEncryptionKey', {
        alias: `alias/${keyAlias}`,
        description: 'Key used to encrypt/decrypt EBS by default',
        enableKeyRotation: true,
      });

      key.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountPrincipal(cdk.Aws.ACCOUNT_ID)],
          actions: ['kms:*'],
          resources: ['*'],
        }),
      );

      // Enable default EBS encryption
      new EbsDefaultEncryption(accountStack, 'EbsDefaultEncryptionSet', {
        key,
      });

      accountEbsEncryptionKeys[localAccountKey] = {
        ...accountEbsEncryptionKeys[localAccountKey],
        [region]: key,
      };

      new CfnEbsKmsOutput(accountStack, 'EbsEncryptionKey', {
        encryptionKeyName: keyAlias,
        encryptionKeyId: key.keyId,
        encryptionKeyArn: key.keyArn,
      });
    }
  }
  return accountEbsEncryptionKeys;
}
