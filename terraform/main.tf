# Main Terraform configuration
terraform {
  required_version = ">= 1.0"
  required_providers {
    flyio = {
      source  = "fly-apps/flyio"
      version = "~> 0.1.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # Remote state for team collaboration
  backend "s3" {
    bucket = "ai-gateway-terraform-state"
    key    = "production/terraform.tfstate"
    region = "us-east-1"
  }
}

variable "environment" {
  type    = string
  default = "production"
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be development, staging, or production."
  }
}

variable "region" {
  type    = string
  default = "cdg"
}

variable "groq_api_key" {
  type      = string
  sensitive = true
}

variable "gateway_api_keys" {
  type      = list(string)
  sensitive = true
}

variable "rate_limit_rpm" {
  type    = number
  default = 6000
}

locals {
  name = "ai-gateway-${var.environment}"

  # Environment-specific settings
  memory = var.environment == "production" ? 2048 : 1024
  cpu    = var.environment == "production" ? 4 : 2

  common_env = {
    NODE_ENV        = var.environment
    PORT            = "4000"
    CORS_ORIGINS    = "*"
    RATE_LIMIT_RPM  = tostring(var.rate_limit_rpm)
    CANARY_DEPLOY   = var.environment == "production" ? "1" : "0"
    LOG_LEVEL       = var.environment == "production" ? "warn" : "debug"
    PROFILE         = "0"
  }

  secrets = {
    GROQ_API_KEY       = var.groq_api_key
    GATEWAY_API_KEYS   = join(",", var.gateway_api_keys)
    DOCKERHUB_USERNAME = ""
    DOCKERHUB_TOKEN    = ""
    VAST_API_KEY       = ""
    RUNPOD_API_KEY     = ""
  }
}

resource "random_id" "app_suffix" {
  byte_length = 4
}

resource "fly_app" "gateway" {
  name         = "${local.name}-${random_id.app_suffix.hex}"
  primary_region = var.region
  kill_signal  = "SIGTERM"
  kill_timeout = "30s"

  services {
    internal_port = 4000
    force_https   = true

    auto_stop_machines   = "stop"
    auto_start_machines  = true
    min_machines_running = var.environment == "production" ? 1 : 0

    concurrency {
      type       = "connections"
      hard_limit = 250
      soft_limit = 100
    }

    checks {
      interval     = "10s"
      timeout      = "5s"
      grace_period = "30s"
      method       = "GET"
      path         = "/health"
    }
  }

  machines {
    size     = "shared-cpu-${local.cpu}x"
    memory   = "${local.memory}mb"

    env = merge(local.common_env, {
      DEPLOY_TIMEOUT_MS       = "2700000" # 45 min
      GPU_MONITOR_INTERVAL_MS = "30000"
    })
  }
}

# Secrets
resource "fly_secret" "groq_api_key" {
  app_id = fly_app.gateway.id
  key    = "GROQ_API_KEY"
  value  = var.groq_api_key
}

resource "fly_secret" "gateway_api_keys" {
  app_id = fly_app.gateway.id
  key    = "GATEWAY_API_KEYS"
  value  = join(",", var.gateway_api_keys)
}

# Outputs
output "app_name" {
  value = fly_app.gateway.name
}

output "app_url" {
  value = "https://${fly_app.gateway.name}.fly.dev"
}

output "health_check_url" {
  value = "https://${fly_app.gateway.name}.fly.dev/health"
}
