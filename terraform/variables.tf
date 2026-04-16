# Variables for AI Gateway deployment

variable "docker_image" {
  description = "Docker image to deploy"
  type        = string
  default     = "marcosremar/ai-gateway:latest"
}

variable "enable_monitoring" {
  description = "Enable monitoring and alerting"
  type        = bool
  default     = true
}

variable "alert_email" {
  description = "Email address for alerts"
  type        = string
  default     = ""
}

variable "daily_budget_usd" {
  description = "Daily budget limit in USD"
  type        = number
  default     = 50
}

variable "dockerhub_username" {
  description = "Optional Docker Hub username secret"
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "dockerhub_token" {
  description = "Optional Docker Hub token secret"
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "vast_api_key" {
  description = "Optional Vast.ai API key secret"
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "runpod_api_key" {
  description = "Optional RunPod API key secret"
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}
