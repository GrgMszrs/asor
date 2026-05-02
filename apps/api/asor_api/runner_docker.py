"""DockerAgentRunner: launches the agent-runner image as a container per run.

Auth: passes Vertex/ADC env vars and mounts the host's ADC credentials file
read-only into the runner container at the standard gcloud path.
"""

from __future__ import annotations

import logging

import docker
from asor_core import Run, Task
from docker.errors import DockerException

from asor_api.config import Settings

log = logging.getLogger(__name__)


class DockerAgentRunner:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        try:
            self._client = docker.from_env()
        except DockerException as exc:
            log.warning("docker client unavailable: %s", exc)
            self._client = None

    def launch(self, task: Task, run: Run) -> str | None:
        if self._client is None:
            log.error("cannot launch runner: docker client not available")
            return None

        s = self._settings
        callback_url = f"{s.asor_api_base_url}/runs/{run.id}/events"
        env = {
            "ASOR_RUN_ID": str(run.id),
            "ASOR_PROMPT": task.prompt,
            "ASOR_CALLBACK_URL": callback_url,
            "ASOR_MODEL": run.invocation.model or s.gemini_model,
            "ASOR_EXTENSIONS": ",".join(run.invocation.extensions),
            "GOOGLE_GENAI_USE_VERTEXAI": s.google_genai_use_vertexai,
            "GOOGLE_CLOUD_PROJECT": s.google_cloud_project,
            "GOOGLE_CLOUD_LOCATION": s.google_cloud_location,
            "GOOGLE_APPLICATION_CREDENTIALS": s.runner_adc_mount_path,
        }

        volumes: dict[str, dict[str, str]] = {}
        if s.asor_gcloud_adc_path:
            volumes[s.asor_gcloud_adc_path] = {
                "bind": s.runner_adc_mount_path,
                "mode": "ro",
            }
        else:
            log.warning("ASOR_GCLOUD_ADC_PATH unset; runner will fail to authenticate")

        container = self._client.containers.run(
            image=s.asor_agent_runner_image,
            environment=env,
            volumes=volumes or None,
            detach=True,
            remove=True,
            network=s.asor_runner_network,
            name=f"asor-runner-{run.id}",
        )
        container_id: str = str(container.id) if container.id else ""
        log.info("launched runner container %s for run %s", container_id, run.id)
        return container_id
