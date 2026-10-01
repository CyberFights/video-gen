import {
  defineRailway,
  github,
  group,
  project,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  const renderer = service("renderer", {
    source: github("CyberFights/video-gen", { rootDirectory: "python-service" }),
    healthcheck: "/health",
    healthcheckTimeout: 30,
    replicas: { "us-west2": 1 },
    env: {
      PORT: "8000",
      VIDEO_BACKEND: "cpu",
    },
  });

  const appData = volume("app-data", {
    region: "us-west2",
    sizeMB: 1024,
  });

  const app = service("app", {
    source: github("CyberFights/video-gen"),
    healthcheck: "/health",
    healthcheckTimeout: 30,
    replicas: { "us-west2": 1 },
    env: {
      DATA_DIR: "/data",
      NODE_ENV: "production",
      PORT: "3000",
      PYTHON_API_HOST: renderer.env.RAILWAY_PRIVATE_DOMAIN,
      PYTHON_API_PORT: "8000",
    },
    volumeMounts: {
      "/data": appData,
    },
  });

  return project("video-gen", {
    resources: [group("Video Gen", [app, renderer, appData])],
  });
});
