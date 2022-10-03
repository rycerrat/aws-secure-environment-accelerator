/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { CloudFormation, objectToCloudFormationParameters } from '@aws-accelerator/common/src/aws/cloudformation';
import { StackTemplateLocation, getTemplateBody } from '../create-stack-set/create-stack-set';
import { STS } from '@aws-accelerator/common/src/aws/sts';
import { DynamoDB } from '@aws-accelerator/common/src/aws/dynamodb';

import { loadAccounts } from '../utils/load-accounts';

interface CreateStackInput {
  stackName: string;
  stackCapabilities: string[];
  stackParameters: { [key: string]: string };
  stackTemplate: StackTemplateLocation;
  accountId?: string;
  assumeRoleName?: string;
  region?: string;
  ignoreAccountId?: string;
  ignoreRegion?: string;
  parametersTableName: string;
}

const dynamodb = new DynamoDB();
const sts = new STS();
export const handler = async (input: CreateStackInput) => {
  console.log(`Creating stack...`);
  console.log(JSON.stringify(input, null, 2));

  const {
    stackName,
    stackCapabilities,
    stackParameters,
    stackTemplate,
    accountId,
    assumeRoleName,
    region,
    ignoreAccountId,
    ignoreRegion,
    parametersTableName
  } = input;

  if (ignoreAccountId && ignoreAccountId === accountId && !ignoreRegion) {
    return;
  } else if (ignoreAccountId && ignoreRegion && ignoreAccountId === accountId && ignoreRegion === region) {
    return;
  }
  console.debug(`Creating stack template`);
  console.debug(stackTemplate);

  const accounts = await loadAccounts(parametersTableName, dynamodb);
  console.log(accounts)

  const targetAccountKeys: string[] = [];
  // if (targetAccounts) {
  //   targetAccounts.map(targetAccount => {
  //     if (targetAccount === 'ALL') {
  //       targetAccountKeys.push('ALL');
  //     } else if (targetAccount === 'NEW') {
  //       targetAccountKeys.push('NEW');
  //     } else {
  //       targetAccountKeys.push(accounts.find(acc => acc.id === targetAccount)?.key!);
  //     }
  //   });
  // }

  // Load the template body from the given location
  const templateBody = await getTemplateBody(stackTemplate);

  let cfn: CloudFormation;
  if (accountId && assumeRoleName) {
    const credentials = await sts.getCredentialsForAccountAndRole(accountId, assumeRoleName);
    cfn = new CloudFormation(credentials, region);
  } else {
    cfn = new CloudFormation();
  }
  await cfn.createOrUpdateStack({
    StackName: stackName,
    TemplateBody: templateBody,
    Capabilities: stackCapabilities,
    Parameters: objectToCloudFormationParameters(stackParameters),
  });
};
