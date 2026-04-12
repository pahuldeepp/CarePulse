"""
CarePulse CDK app entry point.

Deploy:
    cdk deploy -c env=dev
    cdk deploy -c env=prod
"""

import aws_cdk as cdk

from carepulse_stack import CarePulseStack

app = cdk.App()

env_name = app.node.try_get_context("env") or "dev"

CarePulseStack(
    app,
    f"CarePulse-{env_name.capitalize()}",
    env_name=env_name,
    env=cdk.Environment(
        account=app.account,
        region=app.region,
    ),
)

app.synth()
