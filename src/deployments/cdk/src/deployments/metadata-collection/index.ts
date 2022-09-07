import { AccountStacks } from '../../common/account-stacks';
import { Account } from '../../utils/accounts';
import { AcceleratorConfig } from '@aws-accelerator/common-config/src';
import { Organizations } from '@aws-accelerator/custom-resource-organization';
import { createEncryptionKeyName } from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import path from 'path';
import { getAccountId } from '@aws-accelerator/common-outputs/src/accounts';
import { IamRoleNameOutputFinder } from '@aws-accelerator/common-outputs/src/iam-role';
import { StackOutput } from '@aws-accelerator/common-outputs/src/stack-output';
import { createPolicyName } from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
export interface MetadataServiceProps {
  acceleratorPrefix: string;
  accountStacks: AccountStacks;
  accounts: Account[];
  config: AcceleratorConfig;
  configBucket: string;
  outputs: StackOutput[];
}

export function createMetadataService(props: MetadataServiceProps) {
  const { accountStacks, config, acceleratorPrefix } = props;

  const masterAccountConfig = config['global-options']['aws-org-management'];
  const logAccountConfig = config['global-options']['central-log-services'];

  const masterAccountStack = accountStacks.getOrCreateAccountStack(masterAccountConfig.account);
  const logAccountStack = accountStacks.getOrCreateAccountStack(logAccountConfig.account);
  const organizations = new Organizations(logAccountStack, 'MetadataOrganizations');

  const keyAlias = createEncryptionKeyName('Metadata-Key');
  const encryptionKey = new kms.Key(logAccountStack, 'MetadataBucketKey', {
    alias: `alias/${keyAlias}`,
    description: 'Key used to encrypt/decrypt the metadata S3 bucket',
    enableKeyRotation: true,
  });
  const bucketName = `${acceleratorPrefix.toLowerCase()}${getAccountId(
    props.accounts,
    logAccountConfig.account,
  )}-metadata-bucket`;
  const bucket = new s3.Bucket(logAccountStack, 'MetadataBucket', {
    encryptionKey,
    bucketName: bucketName,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    versioned: true,
  });

  // Let the bucket name be generated by CloudFormation
  // The generated bucket name is based on the stack name + logical ID + random suffix
  // overrideLogicalId(bucket, `metadata${masterAccountStack.region}`);

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
  if (metadataReadOnlyRoles.length > 0) {
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
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
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
      BUCKET_NAME: bucketName,
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

  const iamConfig = config.getIamConfigs();
  for (const config of iamConfig) {
    const accountKey = config.accountKey;
    const metadataroles = config.iam.roles?.filter(role => {
      return role['meta-data-read-only-access'];
    });

    const roleOutputs = metadataroles?.map(role => {
      return IamRoleNameOutputFinder.tryFindOneByName({
        outputs: props.outputs,
        accountKey,
        roleName: role.role,
        roleKey: 'IamAccountRole',
      });
    });
    const stackToUpdate = accountStacks.tryGetOrCreateAccountStack(
      accountKey,
      props.config['global-options']['central-log-services'].region,
    );

    if (roleOutputs && roleOutputs.length > 0 && stackToUpdate) {
      for (const output of roleOutputs) {
        const policyName = createPolicyName('MetadataReadOnlyPolicy');
        const metadataPolicy = new iam.ManagedPolicy(stackToUpdate, `IAM-Metadata-Policy-${accountKey}`, {
          managedPolicyName: policyName,
          description: policyName,
        });

        metadataPolicy.addStatements(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
            resources: ['*'],
          }),

          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
          }),
        );
        if (output) {
          metadataPolicy.attachToRole(iam.Role.fromRoleArn(stackToUpdate, 'metadataRole', output.roleArn));
        }
      }
    }
  }
  return bucket;
}
