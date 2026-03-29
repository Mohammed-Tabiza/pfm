import os
from typing import Any

from ag_ui.core.types import ConfiguredBaseModel, Context, Message, RunAgentInput, Tool
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import Field
from fastapi.requests import Request
from fastapi.responses import StreamingResponse

from env_loader import load_env_files
from agent import graph
from banking_store import DB_PATH

load_env_files()

app = FastAPI(title="PFM LangGraph AG-UI Backend", version="0.1.0")

allow_origins = os.getenv("ALLOW_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in allow_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

pfm_agent = LangGraphAgent(
    name="pfm-agent",
    description="Agent de Personal Financial Management avec Generative UI",
    graph=graph,
)


class CompatibleRunAgentInput(ConfiguredBaseModel):
    thread_id: str
    run_id: str
    parent_run_id: str | None = None
    state: Any = Field(default_factory=dict)
    messages: list[Message] = Field(default_factory=list)
    tools: list[Tool] = Field(default_factory=list)
    context: list[Context] = Field(default_factory=list)
    forwarded_props: Any = Field(default_factory=dict)


@app.post("/copilotkit")
async def copilotkit_endpoint(input_data: CompatibleRunAgentInput, request: Request):
    encoder = EventEncoder(accept=request.headers.get("accept"))

    normalized_input = RunAgentInput(
        thread_id=input_data.thread_id,
        run_id=input_data.run_id,
        parent_run_id=input_data.parent_run_id,
        state=input_data.state or {},
        messages=input_data.messages or [],
        tools=input_data.tools or [],
        context=input_data.context or [],
        forwarded_props=input_data.forwarded_props or {},
    )

    async def event_generator():
        async for event in pfm_agent.run(normalized_input):
            yield encoder.encode(event)

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


@app.get("/copilotkit/health")
def copilotkit_health() -> dict:
    return {"status": "ok", "agent": {"name": pfm_agent.name}}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "pfm-agent-backend",
        "sqlite_path": str(DB_PATH),
    }

