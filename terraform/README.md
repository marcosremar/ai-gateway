# Terraform Configuration for AI Gateway

This directory contains Terraform infrastructure-as-code for deploying
AI Gateway to various cloud providers.

## Structure

```
terraform/
├── main.tf              # Main configuration
├── variables.tf         # Input variables
├── outputs.tf           # Output values
├── providers.tf         # Provider configurations
├── environments/
│   ├── dev.tfvars
│   ├── staging.tfvars
│   └── prod.tfvars
├── modules/
│   ├── gateway/         # AI Gateway Fly.io deployment
│   ├── gpu/             # GPU provider infrastructure
│   └── monitoring/      # Monitoring stack
└── state/               # Remote state configuration
```

## Quick Start

```bash
cd terraform

# Initialize Terraform
terraform init

# Plan (see what will change)
terraform plan -var-file=environments/dev.tfvars

# Apply (create infrastructure)
terraform apply -var-file=environments/dev.tfvars

# Destroy (clean up)
terraform destroy -var-file=environments/dev.tfvars
```

## Supported Providers

- **Fly.io** — Primary deployment platform for the gateway
- **RunPod** — GPU instances via API
- **Vast.ai** — GPU instances via API
- **Neon** — PostgreSQL database
- **Upstash** — Redis for state persistence

## State Management

For team usage, configure remote state:

```hcl
terraform {
  backend "s3" {
    bucket = "ai-gateway-terraform-state"
    key    = "production/terraform.tfstate"
    region = "us-east-1"
  }
}
```

Or use Terraform Cloud:

```bash
terraform login
terraform init -migrate-state
```
