import os

import uvicorn

from env_loader import load_env_files


load_env_files()


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT") or os.getenv("BACKEND_PORT", "8123"))
    reload_enabled = os.getenv("RELOAD", "false").lower() == "true"

    uvicorn.run("server:app", host=host, port=port, reload=reload_enabled)

