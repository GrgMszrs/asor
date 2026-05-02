from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    asor_api_base_url: str = "http://api:8000"
    asor_agent_runner_image: str = "asor-agent-runner:dev"
    asor_runner_network: str = "asor_default"
    asor_runner_timeout_seconds: int = 180
    asor_gemini_home_volume: str = "asor-gemini-home"
    database_url: str = ""

    google_genai_use_vertexai: str = "true"
    google_cloud_project: str = ""
    google_cloud_location: str = "global"
    gemini_model: str = "flash"
    asor_gcloud_adc_path: str = ""

    runner_adc_mount_path: str = "/root/.config/gcloud/application_default_credentials.json"
