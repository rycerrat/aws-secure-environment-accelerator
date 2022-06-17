import { AccountStacks } from '../../common/account-stacks';
import { Account } from '../../utils/accounts';
import { AcceleratorConfig } from '@aws-accelerator/common-config/src';
import { Organizations } from '@aws-accelerator/custom-resource-organization';
import { createEncryptionKeyName } from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
import * as targets from '@aws-cdk/aws-events-targets';
import { Rule, Schedule } from '@aws-cdk/aws-events';
import * as kms from '@aws-cdk/aws-kms';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import { overrideLogicalId } from '../../utils/cdk';
import path from 'path';
import * as t from 'io-ts';
import { getAccountId } from '@aws-accelerator/common-outputs/src/accounts';

export interface MetadataServiceProps {
  acceleratorPrefix: string;
  accountStacks: AccountStacks;
  accounts: Account[];
  config: AcceleratorConfig;
  configBucket: string;
}

export function createMetadataService(props: MetadataServiceProps) {
  const { accountStacks, config, acceleratorPrefix } = props;

  const masterAccountConfig = config['global-options']['aws-org-management'];
  const masterAccountStack = accountStacks.getOrCreateAccountStack(masterAccountConfig.account);

  const organizations = new Organizations(masterAccountStack, 'MetadataOrganizations');

  const keyAlias = createEncryptionKeyName('Metadata-Key');
  const encryptionKey = new kms.Key(masterAccountStack, 'MetadataBucketKey', {
    alias: `alias/${keyAlias}`,
    description: 'Key used to encrypt/decrypt the metadata S3 bucket',
    enableKeyRotation: true,
  });

  const bucket = new s3.Bucket(masterAccountStack, 'MetadataBucket', {
    encryptionKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    versioned: true,
  });

  // Let the bucket name be generated by CloudFormation
  // The generated bucket name is based on the stack name + logical ID + random suffix
  overrideLogicalId(bucket, `metadata${masterAccountStack.region}`);

  const anyAccountPrincipal = [new iam.AnyPrincipal()];

  // Update Log Archive Bucket and KMS Key policies for roles with metadata service read only access
  const metadataReadOnlyRoles = [];
  for (const { accountKey, iam: iamConfig } of config.getIamConfigs()) {
    const accountId = getAccountId(props.accounts, accountKey);
    const roles = iamConfig.roles || [];
    for (const role of roles) {
      if (role['meta-data-read-only-access']) {
        metadataReadOnlyRoles.push(new iam.ArnPrincipal(`arn:aws:iam::${accountId}:role/${role.role}`));
      }
    }
  }
  // Give read only access to roles defined in config
  if (metadataReadOnlyRoles) {
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
        principals: metadataReadOnlyRoles,
        resources: ['*'],
      }),
    );

    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        principals: metadataReadOnlyRoles,
      }),
    );
  }
  // Give all ASEA roles access to use this key for decryption
  encryptionKey.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      principals: anyAccountPrincipal,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:PrincipalOrgID': organizations.organizationId,
        },
        ArnLike: {
          'aws:PrincipalARN': `arn:aws:iam::*:role/${acceleratorPrefix}*`,
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
        ArnLike: {
          'aws:PrincipalARN': `arn:aws:iam::*:role/${acceleratorPrefix}*`,
        },
      },
    }),
  );

  // Allow only https requests
  bucket.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ['s3:*'],
      resources: [bucket.bucketArn, bucket.arnForObjects('*')],
      principals: anyAccountPrincipal,
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
      effect: iam.Effect.DENY,
    }),
  );

  const lambdaPath = require.resolve('@aws-accelerator/deployments-runtime');
  const lambdaDir = path.dirname(lambdaPath);
  const lambdaCode = lambda.Code.fromAsset(lambdaDir);
  const lambdaRole = new iam.Role(masterAccountStack, 'metadata-lambda', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    roleName: `${props.acceleratorPrefix}metadata-lambda`,
  });

  lambdaRole.addToPolicy(
    new iam.PolicyStatement({
      resources: ['*'],
      actions: [
        'codecommit:GetFile',
        'dynamodb:BatchGetItem',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:Query',
        'dynamodb:GetItem',
        'dynamodb:Scan',
        'kms:DescribeKey',
        'kms:Decrypt',
        'kms:Encrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'organizations:Describe*',
        'organizations:List*',
        'organizations:Get*',
        'secretsmanager:Get*',
        'ssm:Get*',
        'states:List*',
        'sts:GetCallerIndentity',
        's3:*',
      ],
    }),
  );

  const metadataLambda = new lambda.Function(masterAccountStack, `MetadataLambda`, {
    runtime: lambda.Runtime.NODEJS_14_X,
    code: lambdaCode,
    role: lambdaRole,
    handler: 'index.metadataCollection',
    timeout: cdk.Duration.minutes(10),
    environment: {
      ACCELERATOR_PREFIX: props.acceleratorPrefix,
      BUCKET_NAME: bucket.bucketName,
      CONFIG_REPOSITORY_NAME: process.env.CONFIG_REPOSITORY_NAME || `${props.acceleratorPrefix}Config-Repo`,
      CENTRAL_BUCKET_NAME: props.configBucket,
    },
  });

  encryptionKey.grantEncrypt(metadataLambda);
  bucket.grantWrite(metadataLambda);
  const cloudwatchrule = new Rule(masterAccountStack, `MetadataCWRule`, {
    schedule: Schedule.rate(cdk.Duration.days(1)),
  });

  cloudwatchrule.addTarget(new targets.LambdaFunction(metadataLambda));

  return bucket;
}
