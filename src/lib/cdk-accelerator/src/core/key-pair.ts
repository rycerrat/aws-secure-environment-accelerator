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

import * as cdk from 'aws-cdk-lib/core';
import { Keypair } from '@aws-accelerator/custom-resource-ec2-keypair';
import { createName, createSecretPrefix } from './accelerator-name-generator';

export interface AcceleratorKeypairProps {
  name: string;
}

/**
 * Wrapper around Keypair that automatically adds the Accelerator prefix to the secret.
 */
export class AcceleratorKeypair extends cdk.Construct {
  private readonly resource: Keypair;

  constructor(scope: cdk.Construct, id: string, props: AcceleratorKeypairProps) {
    super(scope, id);

    const keyName = createName({
      name: props.name,
      suffixLength: 0,
    });
    const secretPrefix = createSecretPrefix('keypair/', 0);
    this.resource = new Keypair(this, 'Resource', {
      name: keyName,
      secretPrefix,
    });
  }

  get keyName(): string {
    return this.resource.keyName;
  }
}
