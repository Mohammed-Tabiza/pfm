import os
import json
from typing import Annotated, Any, Dict, List, NotRequired, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from env_loader import load_env_files
from banking_store import BANKING_TOOLS

load_env_files()


class AgentState(TypedDict, total=False):
    messages: Annotated[List[AnyMessage], add_messages]
    tools: List[Dict[str, Any]]
    ui: NotRequired[Dict[str, Any]]
    data: NotRequired[Dict[str, Any]]
    copilotkit: NotRequired[Dict[str, Any]]


SYSTEM_PROMPT = """Tu es un agent PFM (Personal Financial Management) en francais.
Objectif:
- Aider l'utilisateur a piloter budget, depenses, epargne, et projections.
- Favoriser des recommandations actionnables, claires et prudentes.

Important pour la Generative UI:
- Si une visualisation est utile, appelle un tool d'affichage (display-only), par exemple:
  - show_account_snapshot
  - show_budget_breakdown
  - show_savings_plan
- Si une action doit etre validee par l'utilisateur, appelle un tool interactif (HITL), par exemple:
  - confirm_budget_reallocation
  - confirm_savings_transfer
- Tu as aussi des tools serveur SQLite pour lire/manipuler des donnees bancaires fictives.
- Tools SQLite disponibles:
  - list_accounts
  - list_recent_transactions
  - get_spending_by_category
  - get_cashflow_summary
  - get_budget_status
  - reallocate_budget
  - simulate_savings_goal
  - add_mock_transaction
  - transfer_between_accounts
- Priorite: utilise d'abord les tools SQLite pour etablir les faits, puis propose des actions/UI.
- Si l'utilisateur demande un "bilan du mois" ou une "vue budgetaire", appelle:
  1) get_cashflow_summary + get_budget_status
  2) show_account_snapshot + show_budget_breakdown
- Si l'utilisateur demande une reallocation de budget:
  1) appelle get_budget_status si le contexte budgetaire n'est pas deja etabli
  2) appelle confirm_budget_reallocation
  3) si la reponse de validation contient approved=true, appelle reallocate_budget
  4) puis appelle get_budget_status et show_budget_breakdown pour afficher le budget mis a jour
- Si la validation de reallocation est refusee, n'annonce jamais qu'une reallocation a ete appliquee.
- Si l'utilisateur demande une simulation, un objectif ou un plan d'epargne:
  1) appelle simulate_savings_goal
  2) appelle show_savings_plan
  3) si l'utilisateur veut ensuite mettre en place le plan, appelle confirm_savings_transfer
  4) si l'objectif est deja atteint, indique-le clairement tout en affichant la carte de projection
- Si l'utilisateur demande un transfert ou un plan d'epargne avec confirmation:
  1) appelle confirm_savings_transfer
  2) si approved=true, appelle transfer_between_accounts
  3) puis appelle list_accounts et show_account_snapshot pour afficher les soldes mis a jour
- N'affirme jamais qu'une action est effectuee tant qu'un tool de persistance SQLite n'a pas reussi.
- Quand tu emets un tool call, fournis des arguments complets et coherents.
- Contrats d'arguments UI a respecter:
  - show_account_snapshot: {month?, totalBalance, checking, savings, creditCard, incomeToDate?, spentToDate?}
  - show_budget_breakdown: {month?, categories: [{category, budgeted, spent}]}
  - show_savings_plan: {targetAmount, months, currentSavings, goalGap, monthlyContribution, projectedTotal, monthlyCapacity?, targetMonth?, alreadyReached?, withinCashflow?, schedule?}
  - confirm_budget_reallocation: {fromCategory, toCategory, amount, rationale?}
  - confirm_savings_transfer: {fromAccount, toAccount, amount, date}
- Apres un resultat de tool, continue l'analyse de facon concise.
"""


llm = ChatOpenAI(
    base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    api_key=os.getenv("OLLAMA_API_KEY", "ollama"),
    model=os.getenv("OLLAMA_MODEL", "minimax-m2.5:cloud"),
    temperature=float(os.getenv("OLLAMA_TEMPERATURE", "0.2")),
)

SERVER_TOOLS: List[BaseTool] = list(BANKING_TOOLS)
SERVER_TOOL_MAP: Dict[str, BaseTool] = {tool.name: tool for tool in SERVER_TOOLS}
MAX_SERVER_TOOL_STEPS = int(os.getenv("MAX_SERVER_TOOL_STEPS", "6"))


def _normalize_tool_definition(tool: Any) -> Dict[str, Any] | None:
    if hasattr(tool, "model_dump"):
        tool = tool.model_dump()
    elif hasattr(tool, "dict"):
        tool = tool.dict()

    if not isinstance(tool, dict):
        return None

    name = tool.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    parameters = tool.get("parameters")
    if not isinstance(parameters, dict):
        parameters = {"type": "object", "properties": {}}

    return {
        "name": name,
        "description": tool.get("description") or f"Tool {name}",
        "parameters": parameters,
    }


def _resolve_tools(state: AgentState) -> List[Dict[str, Any]]:
    raw_tools = state.get("tools", [])
    if not raw_tools:
        raw_tools = state.get("copilotkit", {}).get("actions", [])

    normalized: List[Dict[str, Any]] = []
    for tool in raw_tools:
        parsed = _normalize_tool_definition(tool)
        if parsed is not None:
            normalized.append(parsed)
    return normalized


def _serialize_tool_result(result: Any) -> str:
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)


def _execute_server_tool(name: str, args: Dict[str, Any]) -> Any:
    if name not in SERVER_TOOL_MAP:
        raise ValueError(f"Outil serveur inconnu: {name}")
    tool = SERVER_TOOL_MAP[name]

    # Important: call the raw function when available to avoid LangChain
    # internal tool run events that currently crash ag_ui_langgraph when
    # tool outputs are plain lists/dicts.
    raw_func = getattr(tool, "func", None)
    if callable(raw_func):
        return raw_func(**args)

    return tool.invoke(args)


def _extract_tool_name(call: Dict[str, Any]) -> str | None:
    name = call.get("name")
    if isinstance(name, str) and name.strip():
        return name

    function_payload = call.get("function")
    if isinstance(function_payload, dict):
        nested_name = function_payload.get("name")
        if isinstance(nested_name, str) and nested_name.strip():
            return nested_name

    return None


def _extract_tool_args(call: Dict[str, Any]) -> Dict[str, Any]:
    args = call.get("args")
    if isinstance(args, dict):
        return args

    function_payload = call.get("function")
    if isinstance(function_payload, dict):
        nested_args = function_payload.get("arguments")
    else:
        nested_args = call.get("arguments")

    if isinstance(nested_args, dict):
        return nested_args

    if isinstance(nested_args, str) and nested_args.strip():
        try:
            parsed = json.loads(nested_args)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {}

    return {}


def _extract_tool_call_id(call: Dict[str, Any], default_name: str) -> str:
    tool_call_id = call.get("id")
    if isinstance(tool_call_id, str) and tool_call_id.strip():
        return tool_call_id
    return f"server-tool-{default_name}"


def _pfm_agent_node(state: AgentState) -> Dict[str, Any]:
    messages = list(state.get("messages", []))
    try:
        frontend_tools = _resolve_tools(state)
        frontend_openai_tools = [convert_to_openai_tool(tool) for tool in frontend_tools]
        model = llm.bind_tools([*SERVER_TOOLS, *frontend_openai_tools])

        conversation: List[AnyMessage] = list(messages)
        new_messages: List[AnyMessage] = []

        for _ in range(MAX_SERVER_TOOL_STEPS):
            response: BaseMessage = model.invoke(
                [SystemMessage(content=SYSTEM_PROMPT), *conversation]
            )
            new_messages.append(response)
            conversation.append(response)

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:
                return {"messages": new_messages}

            has_frontend_tool_call = any(
                (_extract_tool_name(call) or "") not in SERVER_TOOL_MAP for call in tool_calls
            )
            if has_frontend_tool_call:
                # Frontend/HITL tools are executed by CopilotKit runtime (client side).
                # We return immediately so those calls can be handled in UI.
                return {"messages": new_messages}

            for call in tool_calls:
                tool_name = _extract_tool_name(call)
                if not tool_name:
                    tool_message = ToolMessage(
                        content=_serialize_tool_result(
                            {"error": "Tool call sans nom exploitable.", "tool_call": call}
                        ),
                        tool_call_id="server-tool-unknown",
                        name="unknown_tool",
                    )
                    new_messages.append(tool_message)
                    conversation.append(tool_message)
                    continue

                tool_args = _extract_tool_args(call)
                tool_call_id = _extract_tool_call_id(call, tool_name)

                try:
                    result = _execute_server_tool(tool_name, tool_args)
                    content = _serialize_tool_result(result)
                except Exception as exc:  # noqa: BLE001
                    content = _serialize_tool_result({"error": str(exc), "tool": tool_name})

                tool_message = ToolMessage(
                    content=content,
                    tool_call_id=tool_call_id,
                    name=tool_name,
                )
                new_messages.append(tool_message)
                conversation.append(tool_message)

        return {"messages": new_messages}
    except Exception as exc:  # noqa: BLE001
        fallback = AIMessage(
            content=(
                "Le backend agent a rencontre une erreur technique, mais la session reste active. "
                f"Details: {str(exc)}"
            )
        )
        return {"messages": [fallback]}


builder = StateGraph(AgentState)
builder.add_node("pfm_agent", _pfm_agent_node)
builder.add_edge(START, "pfm_agent")
builder.add_edge("pfm_agent", END)
graph = builder.compile(checkpointer=MemorySaver())

