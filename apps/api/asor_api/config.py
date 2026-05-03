from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    asor_amqp_url: str = "amqp://asor:asor@rabbitmq:5672/"
    database_url: str = ""
