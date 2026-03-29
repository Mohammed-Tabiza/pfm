"use client";

import type { Message } from "@ag-ui/client";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  useComponent,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

// ============================================================
// TYPES
// ============================================================

type AccountSnapshotProps = {
  month?: string;
  totalBalance?: number;
  checking?: number;
  savings?: number;
  creditCard?: number;
  incomeToDate?: number;
  spentToDate?: number;
  accounts?: unknown;
};

type BudgetCategory = {
  category: string;
  budgeted?: number;
  spent?: number;
  planned_amount?: number;
  spent_amount?: number;
};

type BudgetBreakdownProps = {
  month?: string;
  categories?: BudgetCategory[] | string;
};

type ReallocationArgs = {
  fromCategory: string;
  toCategory: string;
  amount: number;
  rationale?: string;
};

type SavingsTransferArgs = {
  fromAccount: string;
  toAccount: string;
  amount: number;
  date: string;
};

type SavingsPlanStep = {
  month?: string;
  contribution?: number | string;
  projected_total?: number | string;
  projectedTotal?: number | string;
};

type SavingsPlanProps = {
  targetAmount?: number;
  target_amount?: number;
  months?: number;
  currentSavings?: number;
  current_savings?: number;
  goalGap?: number;
  goal_gap?: number;
  monthlyContribution?: number;
  monthly_contribution?: number;
  projectedTotal?: number;
  projected_total?: number;
  monthlyCapacity?: number;
  monthly_capacity?: number;
  targetMonth?: string;
  target_month?: string;
  alreadyReached?: boolean;
  already_reached?: boolean;
  withinCashflow?: boolean;
  within_cashflow?: boolean;
  schedule?: SavingsPlanStep[] | string;
};

type Transaction = {
  date: string;
  label?: string;
  description?: string;
  amount: number | string;
  category?: string;
  account?: string;
};

type RecentTransactionsProps = {
  transactions?: Transaction[] | string;
  anomalies?: string[] | string;
};

type RenderableMessage = Message & {
  generativeUI?: (() => ReactNode) | ReactNode;
  generativeUIPosition?: "before" | "after";
  toolCalls?: Array<{ function?: { name?: string }; id?: string; name?: string }>;
};

type GeneratedViewEntry = {
  id: string;
  key: string;
  generatedUI: ReactNode;
};

// ============================================================
// CONSTANTS
// ============================================================

const WORKSPACE_VIEW_NAMES = new Set([
  "show_account_snapshot",
  "show_budget_breakdown",
  "show_savings_plan",
  "show_recent_transactions",
  "confirm_budget_reallocation",
  "confirm_savings_transfer",
]);

const CATEGORY_ICONS: Record<string, string> = {
  restaurant: "🍽️",
  repas: "🍽️",
  alimentation: "🛒",
  nourriture: "🛒",
  loyer: "🏠",
  logement: "🏠",
  habitation: "🏠",
  transport: "🚇",
  deplacement: "🚗",
  voiture: "🚗",
  loisir: "🎭",
  divertissement: "🎬",
  sport: "⚽",
  sante: "💊",
  medical: "🏥",
  pharmacie: "💊",
  shopping: "🛍️",
  vetement: "👗",
  mode: "👗",
  epargne: "💰",
  investissement: "📈",
  abonnement: "📺",
  streaming: "📺",
  telephone: "📱",
  internet: "🌐",
  education: "📚",
  formation: "🎓",
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function eur(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

type SnapshotAccount = {
  name?: string;
  account_name?: string;
  account_type?: string;
  type?: string;
  balance?: number | string;
  amount?: number | string;
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseSnapshotAccounts(value: unknown): SnapshotAccount[] {
  let nextValue = value;
  if (typeof nextValue === "string") {
    try { nextValue = JSON.parse(nextValue); } catch { return []; }
  }
  if (!Array.isArray(nextValue)) return [];
  return nextValue.filter((e): e is SnapshotAccount => !!e && typeof e === "object");
}

function parseBudgetCategories(value: unknown): BudgetCategory[] {
  let nextValue = value;
  if (typeof nextValue === "string") {
    try { nextValue = JSON.parse(nextValue); } catch { return []; }
  }
  if (!Array.isArray(nextValue)) return [];
  return nextValue.filter((e): e is BudgetCategory => !!e && typeof e === "object");
}

function parseSavingsSchedule(value: unknown): SavingsPlanStep[] {
  let nextValue = value;
  if (typeof nextValue === "string") {
    try { nextValue = JSON.parse(nextValue); } catch { return []; }
  }
  if (!Array.isArray(nextValue)) return [];
  return nextValue.filter((e): e is SavingsPlanStep => !!e && typeof e === "object");
}

function parseTransactions(value: unknown): Transaction[] {
  let nextValue = value;
  if (typeof nextValue === "string") {
    try { nextValue = JSON.parse(nextValue); } catch { return []; }
  }
  if (!Array.isArray(nextValue)) return [];
  return nextValue.filter((e): e is Transaction => !!e && typeof e === "object");
}

function parseAnomalies(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((e): e is string => typeof e === "string");
    } catch { /* not JSON, treat as single string */ }
    return value.trim() ? [value] : [];
  }
  if (Array.isArray(value)) return value.filter((e): e is string => typeof e === "string");
  return [];
}

function pickBalanceFromAccounts(
  accounts: SnapshotAccount[],
  typeHints: string[],
  nameHints: string[],
): number | undefined {
  for (const account of accounts) {
    const type = String(account.account_type ?? account.type ?? "").toLowerCase();
    const name = String(account.name ?? account.account_name ?? "").toLowerCase();
    const isMatch =
      typeHints.includes(type) ||
      nameHints.some((hint) => (hint ? name.includes(hint) : false));
    if (!isMatch) continue;
    const balance = toNumber(account.balance ?? account.amount);
    if (balance !== undefined) return balance;
  }
  return undefined;
}

function toPlainText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function toRoleLabel(role: string): string {
  if (role === "user") return "Vous";
  if (role === "assistant") return "Agent";
  if (role === "activity") return "Activité";
  return role;
}

function getToolCallNames(message: RenderableMessage): string[] {
  return (message.toolCalls ?? [])
    .map((tc) => tc.function?.name ?? tc.name)
    .filter((n): n is string => Boolean(n));
}

function renderGenerativeUI(message: RenderableMessage): ReactNode {
  if (typeof message.generativeUI === "function") return message.generativeUI();
  return message.generativeUI ?? null;
}

function getWorkspaceViewKey(message: RenderableMessage): string {
  const viewName = getToolCallNames(message).find((n) => WORKSPACE_VIEW_NAMES.has(n));
  return viewName ?? `message-${message.id}`;
}

function getCategoryIcon(category: string): string {
  const lower = category.toLowerCase();
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return "📊";
}

function getBudgetFillClass(ratio: number): string {
  if (ratio > 1) return "budget-fill over";
  if (ratio > 0.85) return "budget-fill warn";
  return "budget-fill ok";
}

// ============================================================
// NEW SUPPORTING UI COMPONENTS
// ============================================================

function CircularProgress({
  value,
  max,
  size = 96,
}: {
  value: number;
  max: number;
  size?: number;
}) {
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(1, max > 0 ? value / max : 0);
  const dashArray = `${pct * circumference} ${circumference}`;
  const cx = size / 2;
  const cy = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block" }}
    >
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--brand)"
        strokeWidth="8"
        strokeDasharray={dashArray}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{
          transition: "stroke-dasharray 0.9s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      />
    </svg>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-wrap">
      <span className="typing-label">Agent</span>
      <div className="typing-dots">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}

// ============================================================
// GENERATIVE UI — DISPLAY COMPONENTS
// ============================================================

function AccountSnapshotCard(props: AccountSnapshotProps) {
  const accounts = parseSnapshotAccounts(props.accounts);

  const checking =
    toNumber(props.checking) ??
    pickBalanceFromAccounts(accounts, ["checking", "current"], ["courant", "checking"]);
  const savings =
    toNumber(props.savings) ??
    pickBalanceFromAccounts(accounts, ["savings"], ["epargne", "savings"]);
  const creditCard =
    toNumber(props.creditCard) ??
    pickBalanceFromAccounts(accounts, ["credit_card", "creditcard", "card"], ["carte", "credit"]);
  const totalBalance =
    toNumber(props.totalBalance) ?? (checking ?? 0) + (savings ?? 0) + (creditCard ?? 0);

  return (
    <div className="gen-card">
      <div className="gen-card-head">
        <p className="gen-card-title">
          Snapshot Comptes{props.month ? ` — ${props.month}` : ""}
        </p>
        <span className="gen-card-chip">Comptes</span>
      </div>

      <div className="snap-hero">
        <p className="snap-hero-label">Solde consolidé</p>
        <p className="snap-hero-amount">{eur(totalBalance)}</p>
        {(props.incomeToDate !== undefined || props.spentToDate !== undefined) && (
          <p className="snap-hero-sub">
            Revenus&nbsp;{eur(props.incomeToDate ?? 0)}
            &nbsp;·&nbsp;
            Dépenses&nbsp;{eur(props.spentToDate ?? 0)}
          </p>
        )}
      </div>

      <div className="gen-card-body">
        <div className="snap-accounts">
          {[
            { type: "Courant", amount: checking },
            { type: "Épargne", amount: savings },
            { type: "Carte", amount: creditCard },
          ].map(({ type, amount }) => (
            <div key={type} className="snap-pill">
              <span className="snap-pill-type">{type}</span>
              <span className={`snap-pill-amount${(amount ?? 0) < 0 ? " neg" : ""}`}>
                {eur(amount ?? 0)}
              </span>
            </div>
          ))}
        </div>

        {(props.incomeToDate !== undefined || props.spentToDate !== undefined) && (
          <div className="snap-flows">
            <div className="snap-flow-cell">
              <p className="snap-flow-label">Revenus</p>
              <p className="snap-flow-amount income">{eur(props.incomeToDate ?? 0)}</p>
            </div>
            <div className="snap-flow-cell">
              <p className="snap-flow-label">Dépenses</p>
              <p className="snap-flow-amount expense">{eur(props.spentToDate ?? 0)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BudgetBreakdownCard(props: BudgetBreakdownProps) {
  const categories = parseBudgetCategories(props.categories);

  return (
    <div className="gen-card">
      <div className="gen-card-head">
        <p className="gen-card-title">
          Budget{props.month ? ` — ${props.month}` : ""}
        </p>
        <span className="gen-card-chip">Budget</span>
      </div>

      <div className="gen-card-body">
        <div className="budget-items">
          {categories.map((entry) => {
            const budgeted = toNumber(entry.budgeted ?? entry.planned_amount) ?? 0;
            const spent = toNumber(entry.spent ?? entry.spent_amount) ?? 0;
            const ratio = budgeted > 0 ? spent / budgeted : 0;
            const isOver = ratio > 1;
            const icon = getCategoryIcon(entry.category);

            return (
              <div key={entry.category}>
                <div className="budget-item-head">
                  <span className="budget-cat">
                    <span className="budget-cat-icon">{icon}</span>
                    {entry.category}
                  </span>
                  <span className="budget-meta">
                    {eur(spent)}&nbsp;/&nbsp;{eur(budgeted)}
                    {isOver && (
                      <span className="budget-meta-over">+{eur(spent - budgeted)}</span>
                    )}
                  </span>
                </div>
                <div className="budget-track">
                  <div
                    className={getBudgetFillClass(ratio)}
                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SavingsPlanCard(props: SavingsPlanProps) {
  const schedule = parseSavingsSchedule(props.schedule);
  const currentSavings = toNumber(props.currentSavings ?? props.current_savings) ?? 0;
  const targetAmount = toNumber(props.targetAmount ?? props.target_amount) ?? 0;
  const goalGap = toNumber(props.goalGap ?? props.goal_gap) ?? 0;
  const monthlyContribution =
    toNumber(props.monthlyContribution ?? props.monthly_contribution) ?? 0;
  const projectedTotal =
    toNumber(props.projectedTotal ?? props.projected_total) ?? currentSavings;
  const monthlyCapacity = toNumber(props.monthlyCapacity ?? props.monthly_capacity);
  const targetMonth = props.targetMonth ?? props.target_month;
  const alreadyReached = props.alreadyReached ?? props.already_reached ?? false;
  const isHealthy = props.withinCashflow ?? props.within_cashflow ?? true;

  const pct = targetAmount > 0 ? Math.min(1, currentSavings / targetAmount) : 0;
  const pctLabel = `${Math.round(pct * 100)}%`;

  return (
    <div className="gen-card">
      <div className="gen-card-head">
        <p className="gen-card-title">
          Plan d&apos;épargne{targetMonth ? ` — cible ${targetMonth}` : ""}
        </p>
        <span className="gen-card-chip">Épargne</span>
      </div>

      <div className="gen-card-body">
        <div className="savings-top">
          <div className="savings-ring-wrap">
            <CircularProgress value={currentSavings} max={targetAmount} size={96} />
            <div className="savings-ring-inner">
              <span className="savings-ring-pct">{pctLabel}</span>
              <span className="savings-ring-sub">atteint</span>
            </div>
          </div>

          <div className="savings-info">
            {alreadyReached ? (
              <span className="savings-status-pill done">✓ Objectif atteint</span>
            ) : (
              <span className={`savings-status-pill ${isHealthy ? "ok" : "tight"}`}>
                {isHealthy ? "✓ Plan soutenable" : "⚠ Plan serré"}
              </span>
            )}
            <div className="savings-info-row">
              <span className="savings-info-label">Objectif</span>
              <span className="savings-info-val">{eur(targetAmount)}</span>
            </div>
            <div className="savings-info-row">
              <span className="savings-info-label">Épargne actuelle</span>
              <span className="savings-info-val">{eur(currentSavings)}</span>
            </div>
            <div className="savings-info-row">
              <span className="savings-info-label">Effort mensuel</span>
              <span className="savings-info-val highlight">{eur(monthlyContribution)}</span>
            </div>
            {monthlyCapacity !== undefined && (
              <div className="savings-info-row">
                <span className="savings-info-label">Capacité estimée</span>
                <span className="savings-info-val">{eur(monthlyCapacity)}</span>
              </div>
            )}
            {!alreadyReached && (
              <div className="savings-info-row">
                <span className="savings-info-label">Reste à constituer</span>
                <span className="savings-info-val">{eur(goalGap)}</span>
              </div>
            )}
          </div>
        </div>

        {schedule.length > 0 && (
          <div className="savings-table">
            <div className="savings-table-head">
              <span>Mois</span>
              <span>Versement</span>
              <span>Total projeté</span>
            </div>
            {schedule.map((step) => {
              const contribution = toNumber(step.contribution) ?? 0;
              const total = toNumber(step.projected_total ?? step.projectedTotal) ?? 0;
              return (
                <div key={step.month ?? String(total)} className="savings-table-row">
                  <span>{step.month ?? "—"}</span>
                  <span>{eur(contribution)}</span>
                  <strong>{eur(total)}</strong>
                </div>
              );
            })}
          </div>
        )}

        {projectedTotal > 0 && schedule.length === 0 && (
          <div className="savings-info-row" style={{ marginTop: "0.5rem" }}>
            <span className="savings-info-label">Total projeté</span>
            <span className="savings-info-val highlight">{eur(projectedTotal)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function RecentTransactionsCard(props: RecentTransactionsProps) {
  const transactions = parseTransactions(props.transactions);
  const anomalies = parseAnomalies(props.anomalies);

  return (
    <div className="gen-card">
      <div className="gen-card-head">
        <p className="gen-card-title">Transactions récentes</p>
        <span className="gen-card-chip">Activité</span>
      </div>
      <div className="gen-card-body">
        {anomalies.length > 0 && (
          <div className="tx-anomalies">
            {anomalies.map((anomaly, index) => (
              <p key={`${anomaly}-${index}`} className="tx-anomaly-item">
                ⚠ {anomaly}
              </p>
            ))}
          </div>
        )}

        <div className="tx-list">
          {transactions.map((tx, index) => {
            const amount = toNumber(tx.amount) ?? 0;
            const label = tx.label ?? tx.description ?? "—";
            const isAnomalous = anomalies.some((anomaly) =>
              anomaly.toLowerCase().includes(label.toLowerCase().slice(0, 10)),
            );

            return (
              <div
                key={`${tx.date}-${label}-${index}`}
                className={`tx-row${isAnomalous ? " tx-row-anomaly" : ""}`}
              >
                <span className="tx-date">{tx.date}</span>
                <div className="tx-meta">
                  <span className="tx-label">{label}</span>
                  {tx.category && <span className="tx-category">{tx.category}</span>}
                </div>
                <span className={`tx-amount${amount < 0 ? " neg" : " pos"}`}>
                  {eur(amount)}
                </span>
              </div>
            );
          })}

          {transactions.length === 0 && (
            <p className="tx-empty">Aucune transaction disponible.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// GENERATIVE UI — HITL COMPONENTS
// ============================================================

function ReallocationApprovalCard(props: {
  name: string;
  description: string;
  args: Partial<ReallocationArgs>;
  status: "inProgress" | "executing" | "complete";
  result?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  return (
    <div className="hitl-card">
      <div className="hitl-head">
        <span className="hitl-pulse" />
        <span className="hitl-head-text">Validation requise</span>
      </div>

      <div className="hitl-body">
        <p className="hitl-title">Réallocation budgétaire</p>

        <div className="hitl-flow">
          <div className="hitl-flow-side">
            <p className="hitl-flow-side-label">Depuis</p>
            <p className="hitl-flow-side-name">{props.args.fromCategory ?? "—"}</p>
          </div>
          <div className="hitl-flow-center">
            <span className="hitl-flow-arrow">→</span>
            <span className="hitl-flow-amount">{eur(props.args.amount ?? 0)}</span>
          </div>
          <div className="hitl-flow-side" style={{ textAlign: "right" }}>
            <p className="hitl-flow-side-label">Vers</p>
            <p className="hitl-flow-side-name">{props.args.toCategory ?? "—"}</p>
          </div>
        </div>

        {props.args.rationale && (
          <p className="hitl-rationale">{props.args.rationale}</p>
        )}

        {props.status === "executing" && props.respond ? (
          <div className="hitl-actions">
            <button
              className="btn-approve"
              type="button"
              onClick={() => void props.respond?.({ approved: true })}
            >
              ✓ Approuver
            </button>
            <button
              className="btn-reject"
              type="button"
              onClick={() =>
                void props.respond?.({ approved: false, reason: "Ajustement préféré" })
              }
            >
              ✕ Refuser
            </button>
          </div>
        ) : null}

        {props.status === "inProgress" && (
          <p className="hitl-status">Préparation de la demande…</p>
        )}
        {props.status === "complete" && (
          <p className="hitl-status">Décision enregistrée : {props.result ?? "OK"}</p>
        )}
      </div>
    </div>
  );
}

function SavingsTransferApprovalCard(props: {
  name: string;
  description: string;
  args: Partial<SavingsTransferArgs>;
  status: "inProgress" | "executing" | "complete";
  result?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  return (
    <div className="hitl-card">
      <div className="hitl-head">
        <span className="hitl-pulse" />
        <span className="hitl-head-text">Confirmation requise</span>
      </div>

      <div className="hitl-body">
        <p className="hitl-title">Transfert vers épargne</p>

        <div className="hitl-flow">
          <div className="hitl-flow-side">
            <p className="hitl-flow-side-label">Compte source</p>
            <p className="hitl-flow-side-name">{props.args.fromAccount ?? "—"}</p>
          </div>
          <div className="hitl-flow-center">
            <span className="hitl-flow-arrow">→</span>
            <span className="hitl-flow-amount">{eur(props.args.amount ?? 0)}</span>
          </div>
          <div className="hitl-flow-side" style={{ textAlign: "right" }}>
            <p className="hitl-flow-side-label">Destination</p>
            <p className="hitl-flow-side-name">{props.args.toAccount ?? "—"}</p>
          </div>
        </div>

        {props.args.date && (
          <p className="hitl-rationale" style={{ fontStyle: "normal" }}>
            📅 Date prévue&nbsp;: <strong>{props.args.date}</strong>
          </p>
        )}

        {props.status === "executing" && props.respond ? (
          <div className="hitl-actions">
            <button
              className="btn-approve"
              type="button"
              onClick={() => void props.respond?.({ approved: true })}
            >
              ✓ Confirmer
            </button>
            <button
              className="btn-reject"
              type="button"
              onClick={() =>
                void props.respond?.({ approved: false, reason: "Reporter" })
              }
            >
              ✕ Reporter
            </button>
          </div>
        ) : null}

        {props.status === "inProgress" && (
          <p className="hitl-status">En attente des détails…</p>
        )}
        {props.status === "complete" && (
          <p className="hitl-status">Décision enregistrée : {props.result ?? "OK"}</p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

const SUGGESTIONS = [
  { icon: "📊", text: "Bilan du mois et vue budgétaire complète" },
  { icon: "🔄", text: "Proposer une réallocation budget Restaurants" },
  { icon: "🎯", text: "Simuler un plan d'épargne de 10 000 € en 9 mois" },
  { icon: "🧾", text: "Montre mes 10 dernières transactions et identifie les anomalies" },
  { icon: "💸", text: "Quel est mon cashflow ce mois-ci, suis-je dans le vert ?" },
  { icon: "💳", text: "Virer 200 € de mon compte courant vers l'épargne ce soir" },
];

const TECH_STACK = [
  ["CopilotKit", "Generative UI"],
  ["LangGraph", "Orchestration"],
  ["Ollama", "LLM local"],
  ["FastAPI", "AG-UI Backend"],
] as const;

export default function Home() {
  const { messages, sendMessage, stopGeneration, isLoading } = useCopilotChatInternal();
  const [prompt, setPrompt] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Generative UI hooks ──────────────────────────────────

  useComponent(
    {
      name: "show_account_snapshot",
      description: "Affiche un résumé des comptes et de la trésorerie.",
      parameters: z.object({
        month: z.string().optional(),
        totalBalance: z.coerce.number().optional(),
        checking: z.coerce.number().optional(),
        savings: z.coerce.number().optional(),
        creditCard: z.coerce.number().optional(),
        incomeToDate: z.coerce.number().optional(),
        spentToDate: z.coerce.number().optional(),
        accounts: z
          .union([
            z.string(),
            z.array(
              z.object({
                name: z.string().optional(),
                account_name: z.string().optional(),
                account_type: z.string().optional(),
                type: z.string().optional(),
                balance: z.coerce.number().optional(),
                amount: z.coerce.number().optional(),
              }),
            ),
          ])
          .optional(),
      }),
      render: AccountSnapshotCard,
    },
    [],
  );

  useComponent(
    {
      name: "show_budget_breakdown",
      description: "Affiche les catégories budgétaires et leur avancement.",
      parameters: z.object({
        month: z.string().optional(),
        categories: z
          .union([
            z.string(),
            z.array(
              z.object({
                category: z.string(),
                budgeted: z.coerce.number().optional(),
                spent: z.coerce.number().optional(),
                planned_amount: z.coerce.number().optional(),
                spent_amount: z.coerce.number().optional(),
              }),
            ),
          ])
          .optional(),
      }),
      render: BudgetBreakdownCard,
    },
    [],
  );

  useComponent(
    {
      name: "show_savings_plan",
      description:
        "Affiche une projection d'épargne avec objectif, effort mensuel et trajectoire.",
      parameters: z.object({
        targetAmount: z.coerce.number().optional(),
        target_amount: z.coerce.number().optional(),
        months: z.coerce.number().optional(),
        currentSavings: z.coerce.number().optional(),
        current_savings: z.coerce.number().optional(),
        goalGap: z.coerce.number().optional(),
        goal_gap: z.coerce.number().optional(),
        monthlyContribution: z.coerce.number().optional(),
        monthly_contribution: z.coerce.number().optional(),
        projectedTotal: z.coerce.number().optional(),
        projected_total: z.coerce.number().optional(),
        monthlyCapacity: z.coerce.number().optional(),
        monthly_capacity: z.coerce.number().optional(),
        targetMonth: z.string().optional(),
        target_month: z.string().optional(),
        alreadyReached: z.boolean().optional(),
        already_reached: z.boolean().optional(),
        withinCashflow: z.boolean().optional(),
        within_cashflow: z.boolean().optional(),
        schedule: z
          .union([
            z.string(),
            z.array(
              z.object({
                month: z.string().optional(),
                contribution: z.coerce.number().optional(),
                projected_total: z.coerce.number().optional(),
                projectedTotal: z.coerce.number().optional(),
              }),
            ),
          ])
          .optional(),
      }),
      render: SavingsPlanCard,
    },
    [],
  );

  useComponent(
    {
      name: "show_recent_transactions",
      description: "Affiche les transactions récentes et les anomalies détectées.",
      parameters: z.object({
        transactions: z.union([
          z.string(),
          z.array(z.object({
            date: z.string(),
            label: z.string().optional(),
            description: z.string().optional(),
            amount: z.coerce.number(),
            category: z.string().optional(),
            account: z.string().optional(),
          })),
        ]).optional(),
        anomalies: z.union([z.string(), z.array(z.string())]).optional(),
      }),
      render: RecentTransactionsCard,
    },
    [],
  );

  useHumanInTheLoop(
    {
      name: "confirm_budget_reallocation",
      description: "Demande la validation utilisateur pour une réallocation budgétaire.",
      parameters: z.object({
        fromCategory: z.string(),
        toCategory: z.string(),
        amount: z.number(),
        rationale: z.string().optional(),
      }),
      followUp: true,
      render: ReallocationApprovalCard,
    },
    [],
  );

  useHumanInTheLoop(
    {
      name: "confirm_savings_transfer",
      description: "Demande confirmation avant de planifier un transfert vers épargne.",
      parameters: z.object({
        fromAccount: z.string(),
        toAccount: z.string(),
        amount: z.number(),
        date: z.string(),
      }),
      followUp: true,
      render: SavingsTransferApprovalCard,
    },
    [],
  );

  // ── Derived state ────────────────────────────────────────

  const chatMessages = useMemo(() => [...(messages as RenderableMessage[])], [messages]);

  const renderedMessages = useMemo(() => {
    return chatMessages.filter((message) => {
      if (message.role === "tool") return false;

      const text = toPlainText(message);
      const toolCallNames = getToolCallNames(message);
      const generatedUI = renderGenerativeUI(message);

      if (message.role === "assistant") {
        if (!text && toolCallNames.length > 0) return false;
        if (!text && generatedUI) return false;
      }

      return true;
    });
  }, [chatMessages]);

  const currentIntent = useMemo(() => {
    let lastUserIndex = -1;
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
      if (chatMessages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return { prompt: "", messages: [] as RenderableMessage[] };
    }
    return {
      prompt: toPlainText(chatMessages[lastUserIndex]),
      messages: chatMessages.slice(lastUserIndex + 1),
    };
  }, [chatMessages]);

  const generatedViews = useMemo(() => {
    const latestViews = new Map<string, GeneratedViewEntry>();
    for (const message of currentIntent.messages) {
      if (message.role !== "assistant") continue;
      const generatedUI = renderGenerativeUI(message);
      if (!generatedUI) continue;
      const key = getWorkspaceViewKey(message);
      if (latestViews.has(key)) latestViews.delete(key);
      latestViews.set(key, { id: message.id, key, generatedUI });
    }
    return Array.from(latestViews.values());
  }, [currentIntent.messages]);

  // ── Auto-scroll ──────────────────────────────────────────

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [renderedMessages.length, isLoading]);

  // ── Actions ──────────────────────────────────────────────

  async function runPrompt(nextPrompt: string) {
    const text = nextPrompt.trim();
    if (!text || isLoading) return;
    await sendMessage({ id: crypto.randomUUID(), role: "user", content: text });
  }

  async function handleSend() {
    const current = prompt.trim();
    if (!current || isLoading) return;
    setPrompt("");
    await runPrompt(current);
  }

  // ── Render ───────────────────────────────────────────────

  return (
    <main className="pfm-shell">
      {/* ── Top Bar ─────────────────────────────────────── */}
      <header className="pfm-topbar">
        <div className="pfm-brand">
          <div className="pfm-brand-icon">💰</div>
          <span className="pfm-brand-name">PFM Agent</span>
          <span className="pfm-brand-sep" />
          <span className="pfm-brand-tagline">Personal Financial Management</span>
        </div>
        <div className="pfm-tech-pills">
          <span className="tech-pill">CopilotKit</span>
          <span className="tech-pill">LangGraph</span>
          <span className="tech-pill">Ollama</span>
          <span className="tech-pill">Generative UI</span>
        </div>
      </header>

      <div className="pfm-grid">
        {/* ── Sidebar ───────────────────────────────────── */}
        <aside className="pfm-panel sidebar-panel">
          {/* Agent status */}
          <div className="agent-status">
            <div className={`agent-dot${isLoading ? " loading" : ""}`} />
            <span className="agent-label">
              {isLoading ? "En exécution…" : "Agent prêt"}
            </span>
          </div>

          {/* Quick scenarios */}
          <div>
            <p className="panel-label">Scénarios rapides</p>
            <div className="suggestion-list">
              {SUGGESTIONS.map((item) => (
                <button
                  key={item.text}
                  type="button"
                  className="suggestion-btn"
                  onClick={() => void runPrompt(item.text)}
                  disabled={isLoading}
                >
                  <span className="suggestion-icon">{item.icon}</span>
                  <span className="suggestion-text">{item.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-divider" />

          {/* Tech stack */}
          <div>
            <p className="panel-label">Stack technique</p>
            <div className="tech-stack-list">
              {TECH_STACK.map(([name, role]) => (
                <div key={name} className="tech-stack-item">
                  <span className="tech-stack-item-name">{name}</span>
                  <span className="tech-stack-item-role">{role}</span>
                  <span className="tech-stack-dot" />
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* ── Workspace ─────────────────────────────────── */}
        <section className="pfm-panel workspace-panel">
          <div className="workspace-header">
            <div>
              <p className="panel-label">Generative UI</p>
              <p className="panel-title">Workspace Financier</p>
              {currentIntent.prompt && (
                <p className="workspace-intent">
                  &laquo;&nbsp;{currentIntent.prompt}&nbsp;&raquo;
                </p>
              )}
            </div>
            <span className={`workspace-badge${generatedViews.length > 0 ? " active" : ""}`}>
              {generatedViews.length > 0
                ? `${generatedViews.length} vue${generatedViews.length > 1 ? "s" : ""}`
                : "En attente"}
            </span>
          </div>

          {generatedViews.length === 0 ? (
            <div className="workspace-empty">
              <span className="ws-empty-icon">📈</span>
              <p className="ws-empty-text">
                Lancez une analyse pour faire apparaître les cartes budgétaires, snapshots
                de comptes et validations interactives.
              </p>
            </div>
          ) : (
            <div className="workspace-stack">
              {generatedViews.map((entry) => (
                <div key={`${entry.id}-workspace`} className="workspace-item">
                  {entry.generatedUI}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Chat ──────────────────────────────────────── */}
        <section className="pfm-panel chat-panel">
          <div className="chat-header">
            <div>
              <p className="panel-label">Historique</p>
              <p className="panel-title">Conversation</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => stopGeneration()}
              disabled={!isLoading}
            >
              ✕&nbsp;Stop
            </button>
          </div>

          <div className="chat-messages">
            {renderedMessages.length === 0 ? (
              <div className="chat-empty">
                <span className="chat-empty-icon">💬</span>
                <p className="chat-empty-text">
                  Posez une question sur votre budget, vos dépenses, votre épargne ou vos
                  projections.
                </p>
              </div>
            ) : (
              renderedMessages.map((message) => {
                const text = toPlainText(message);
                const role = message.role;
                if (!text) return null;
                return (
                  <div key={message.id} className={`msg-bubble msg-${role}`}>
                    <span className="msg-label">{toRoleLabel(role)}</span>
                    <div className="msg-text">{text}</div>
                  </div>
                );
              })
            )}

            {isLoading && <TypingIndicator />}
            <div ref={chatEndRef} />
          </div>

          {/* Compose */}
          <div className="chat-compose">
            <textarea
              className="compose-field"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Ex : Analyse mes dépenses et propose un plan d'épargne…"
              disabled={isLoading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="compose-row">
              <span className="compose-hint">Entrée pour envoyer&nbsp;·&nbsp;⇧ Entrée pour nouvelle ligne</span>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleSend()}
                disabled={isLoading || !prompt.trim()}
              >
                Envoyer →
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
