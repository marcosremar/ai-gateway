# Outputs for AI Gateway deployment

output "environment" {
  value = var.environment
}

output "region" {
  value = var.region
}

output "memory_mb" {
  value = local.memory
}

output "cpu_count" {
  value = local.cpu
}

output "secrets_configured" {
  value = {
    groq_api_key         = var.groq_api_key != ""
    gateway_api_keys_count = length(var.gateway_api_keys)
  }
  sensitive = true
}
