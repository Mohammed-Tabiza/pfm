import os
import sqlite3
from math import ceil
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

DB_PATH = Path(
    os.getenv(
        "PFM_SQLITE_PATH",
        str((Path(__file__).resolve().parent / "pfm_demo.sqlite3")),
    )
)


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def _spent_map_for_month(conn: sqlite3.Connection, month_value: str) -> dict[str, float]:
    rows = conn.execute(
        """
        SELECT category, ROUND(SUM(amount), 2) AS spent_amount
        FROM transactions
        WHERE direction = 'debit'
          AND substr(transaction_date, 1, 7) = ?
        GROUP BY category
        """,
        (month_value,),
    ).fetchall()
    return {str(row["category"]): float(row["spent_amount"] or 0) for row in rows}


def _get_account_id(conn: sqlite3.Connection, account_name: str) -> int:
    row = conn.execute(
        "SELECT id FROM accounts WHERE name = ?",
        (account_name,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Compte introuvable: {account_name}")
    return int(row["id"])


def _default_month() -> str:
    return date.today().strftime("%Y-%m")


def _month_after(month_value: str, offset: int) -> str:
    year_text, month_text = month_value.split("-", 1)
    year = int(year_text)
    month = int(month_text)
    month_index = (year * 12 + (month - 1)) + offset
    next_year = month_index // 12
    next_month = (month_index % 12) + 1
    return f"{next_year:04d}-{next_month:02d}"


def initialize_demo_database(force_reset: bool = False) -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                account_type TEXT NOT NULL,
                currency TEXT NOT NULL DEFAULT 'EUR',
                balance REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                transaction_date TEXT NOT NULL,
                direction TEXT NOT NULL CHECK(direction IN ('debit', 'credit')),
                amount REAL NOT NULL,
                category TEXT NOT NULL,
                merchant TEXT NOT NULL,
                note TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(account_id) REFERENCES accounts(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS budgets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month TEXT NOT NULL,
                category TEXT NOT NULL,
                planned_amount REAL NOT NULL,
                UNIQUE(month, category)
            )
            """
        )

        if force_reset:
            conn.execute("DELETE FROM transactions")
            conn.execute("DELETE FROM budgets")
            conn.execute("DELETE FROM accounts")

        existing_accounts = conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()
        if existing_accounts and int(existing_accounts["n"]) > 0:
            return

        accounts_seed = [
            ("Courant", "checking", "EUR", 3240.0),
            ("Epargne", "savings", "EUR", 8600.0),
            ("Carte", "credit_card", "EUR", -410.0),
        ]
        conn.executemany(
            """
            INSERT INTO accounts (name, account_type, currency, balance)
            VALUES (?, ?, ?, ?)
            """,
            accounts_seed,
        )

        month = _default_month()
        today = date.today()
        d = lambda n: (today - timedelta(days=n)).isoformat()

        transactions_seed = [
            ("Courant", d(2), "debit", 46.9, "courses", "Monoprix", "Courses semaine"),
            ("Courant", d(4), "debit", 22.0, "transport", "SNCF", "Abonnement"),
            ("Courant", d(5), "debit", 67.4, "restauration", "Uber Eats", "Livraison"),
            ("Courant", d(8), "debit", 93.0, "loisirs", "Fnac", "Jeux/video"),
            ("Courant", d(12), "credit", 3150.0, "revenus", "Entreprise", "Salaire"),
            ("Courant", d(15), "debit", 960.0, "logement", "Loyer", "Loyer mensuel"),
            ("Courant", d(18), "debit", 120.0, "sante", "Pharmacie", "Santé"),
            ("Carte", d(3), "debit", 38.0, "restauration", "Cafe", "Dejeuner"),
            ("Carte", d(7), "debit", 125.0, "shopping", "Zara", "Vetements"),
            ("Epargne", d(10), "credit", 300.0, "epargne", "Virement", "Versement auto"),
        ]

        for name, tx_date, direction, amount, category, merchant, note in transactions_seed:
            account_id = _get_account_id(conn, name)
            conn.execute(
                """
                INSERT INTO transactions (
                    account_id, transaction_date, direction, amount, category, merchant, note
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (account_id, tx_date, direction, amount, category, merchant, note),
            )

        budgets_seed = [
            (month, "courses", 420.0),
            (month, "transport", 120.0),
            (month, "restauration", 240.0),
            (month, "loisirs", 180.0),
            (month, "shopping", 190.0),
            (month, "sante", 150.0),
            (month, "logement", 980.0),
            (month, "epargne", 300.0),
        ]
        conn.executemany(
            """
            INSERT INTO budgets (month, category, planned_amount)
            VALUES (?, ?, ?)
            """,
            budgets_seed,
        )


@tool
def list_accounts() -> list[dict[str, Any]]:
    """Retourne les comptes bancaires fictifs et leurs soldes."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT name, account_type, currency, ROUND(balance, 2) AS balance
            FROM accounts
            ORDER BY id
            """
        ).fetchall()
    return _rows_to_dicts(rows)


@tool
def list_recent_transactions(
    account_name: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Retourne les transactions recentes (filtrables par compte)."""
    safe_limit = max(1, min(limit, 100))
    with _connect() as conn:
        if account_name:
            rows = conn.execute(
                """
                SELECT a.name AS account_name, t.transaction_date, t.direction, ROUND(t.amount, 2) AS amount,
                       t.category, t.merchant, t.note
                FROM transactions t
                JOIN accounts a ON a.id = t.account_id
                WHERE a.name = ?
                ORDER BY t.transaction_date DESC, t.id DESC
                LIMIT ?
                """,
                (account_name, safe_limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT a.name AS account_name, t.transaction_date, t.direction, ROUND(t.amount, 2) AS amount,
                       t.category, t.merchant, t.note
                FROM transactions t
                JOIN accounts a ON a.id = t.account_id
                ORDER BY t.transaction_date DESC, t.id DESC
                LIMIT ?
                """,
                (safe_limit,),
            ).fetchall()
    return _rows_to_dicts(rows)


@tool
def get_spending_by_category(month: str | None = None) -> list[dict[str, Any]]:
    """Retourne les depenses agregees par categorie pour un mois (YYYY-MM)."""
    month_value = month or _default_month()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT t.category, ROUND(SUM(t.amount), 2) AS spent
            FROM transactions t
            WHERE t.direction = 'debit'
              AND substr(t.transaction_date, 1, 7) = ?
            GROUP BY t.category
            ORDER BY spent DESC
            """,
            (month_value,),
        ).fetchall()
    return _rows_to_dicts(rows)


@tool
def get_cashflow_summary(month: str | None = None) -> dict[str, Any]:
    """Retourne un resume cashflow (credits, debits, net) pour un mois."""
    month_value = month or _default_month()
    with _connect() as conn:
        by_type = conn.execute(
            """
            SELECT direction, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE substr(transaction_date, 1, 7) = ?
            GROUP BY direction
            """,
            (month_value,),
        ).fetchall()
        by_account = conn.execute(
            """
            SELECT a.name AS account_name,
                   ROUND(SUM(CASE WHEN t.direction='credit' THEN t.amount ELSE 0 END), 2) AS credits,
                   ROUND(SUM(CASE WHEN t.direction='debit' THEN t.amount ELSE 0 END), 2) AS debits
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE substr(t.transaction_date, 1, 7) = ?
            GROUP BY a.name
            ORDER BY a.name
            """,
            (month_value,),
        ).fetchall()

    credits = 0.0
    debits = 0.0
    for row in by_type:
        if row["direction"] == "credit":
            credits = float(row["total"] or 0)
        if row["direction"] == "debit":
            debits = float(row["total"] or 0)

    return {
        "month": month_value,
        "credits": round(credits, 2),
        "debits": round(debits, 2),
        "net": round(credits - debits, 2),
        "by_account": [
            {
                "account_name": row["account_name"],
                "credits": float(row["credits"] or 0),
                "debits": float(row["debits"] or 0),
                "net": round(float(row["credits"] or 0) - float(row["debits"] or 0), 2),
            }
            for row in by_account
        ],
    }


@tool
def get_budget_status(month: str | None = None) -> dict[str, Any]:
    """Retourne le statut budgetaire (prevu vs depense) pour chaque categorie."""
    month_value = month or _default_month()
    with _connect() as conn:
        budgets = conn.execute(
            """
            SELECT category, ROUND(planned_amount, 2) AS planned_amount
            FROM budgets
            WHERE month = ?
            ORDER BY category
            """,
            (month_value,),
        ).fetchall()
        spent_map = _spent_map_for_month(conn, month_value)
    categories: list[dict[str, Any]] = []
    for row in budgets:
        category = str(row["category"])
        planned = float(row["planned_amount"] or 0)
        spent = float(spent_map.get(category, 0))
        categories.append(
            {
                "category": category,
                "planned_amount": round(planned, 2),
                "spent_amount": round(spent, 2),
                "remaining_amount": round(planned - spent, 2),
                "over_budget": spent > planned,
            }
        )

    return {"month": month_value, "categories": categories}


@tool
def reallocate_budget(
    from_category: str,
    to_category: str,
    amount: float,
    month: str | None = None,
) -> dict[str, Any]:
    """Realloue un montant de budget d'une categorie vers une autre pour un mois."""
    if from_category == to_category:
        raise ValueError("Les categories source et destination doivent etre differentes.")
    if amount <= 0:
        raise ValueError("Le montant doit etre strictement positif.")

    month_value = month or _default_month()
    normalized_amount = round(float(amount), 2)

    with _connect() as conn:
        source_row = conn.execute(
            """
            SELECT ROUND(planned_amount, 2) AS planned_amount
            FROM budgets
            WHERE month = ? AND category = ?
            """,
            (month_value, from_category),
        ).fetchone()
        if source_row is None:
            raise ValueError(f"Budget source introuvable: {from_category}")

        target_row = conn.execute(
            """
            SELECT ROUND(planned_amount, 2) AS planned_amount
            FROM budgets
            WHERE month = ? AND category = ?
            """,
            (month_value, to_category),
        ).fetchone()

        source_planned = float(source_row["planned_amount"] or 0)
        target_planned = float(target_row["planned_amount"] or 0) if target_row else 0.0
        spent_map = _spent_map_for_month(conn, month_value)
        source_spent = float(spent_map.get(from_category, 0))
        next_source = round(source_planned - normalized_amount, 2)
        next_target = round(target_planned + normalized_amount, 2)

        if next_source < 0:
            raise ValueError(
                f"Budget insuffisant dans {from_category}: disponible {source_planned:.2f} EUR."
            )
        if next_source < source_spent:
            raise ValueError(
                f"Impossible de reduire {from_category} a {next_source:.2f} EUR "
                f"car {source_spent:.2f} EUR ont deja ete depenses."
            )

        conn.execute(
            """
            UPDATE budgets
            SET planned_amount = ?, id = id
            WHERE month = ? AND category = ?
            """,
            (next_source, month_value, from_category),
        )
        conn.execute(
            """
            INSERT INTO budgets (month, category, planned_amount)
            VALUES (?, ?, ?)
            ON CONFLICT(month, category)
            DO UPDATE SET planned_amount = excluded.planned_amount
            """,
            (month_value, to_category, next_target),
        )

    return {
        "month": month_value,
        "from_category": from_category,
        "to_category": to_category,
        "amount": normalized_amount,
        "updated_budgets": [
            {
                "category": from_category,
                "planned_amount": next_source,
                "spent_amount": source_spent,
                "remaining_amount": round(next_source - source_spent, 2),
            },
            {
                "category": to_category,
                "planned_amount": next_target,
                "spent_amount": float(spent_map.get(to_category, 0)),
                "remaining_amount": round(next_target - float(spent_map.get(to_category, 0)), 2),
            },
        ],
    }


@tool
def simulate_savings_goal(
    target_amount: float,
    months: int,
    savings_account: str = "Epargne",
    month: str | None = None,
) -> dict[str, Any]:
    """Simule un plan d'epargne automatique pour atteindre un objectif sur N mois."""
    if target_amount <= 0:
        raise ValueError("L'objectif d'epargne doit etre strictement positif.")
    if months <= 0:
        raise ValueError("Le nombre de mois doit etre strictement positif.")

    month_value = month or _default_month()
    normalized_target = round(float(target_amount), 2)

    with _connect() as conn:
        savings_row = conn.execute(
            """
            SELECT name, ROUND(balance, 2) AS balance
            FROM accounts
            WHERE name = ?
            """,
            (savings_account,),
        ).fetchone()
        if savings_row is None:
            raise ValueError(f"Compte epargne introuvable: {savings_account}")

        cashflow_rows = conn.execute(
            """
            SELECT direction, ROUND(SUM(amount), 2) AS total
            FROM transactions
            WHERE substr(transaction_date, 1, 7) = ?
            GROUP BY direction
            """,
            (month_value,),
        ).fetchall()

    current_savings = float(savings_row["balance"] or 0)
    credits = 0.0
    debits = 0.0
    for row in cashflow_rows:
        if row["direction"] == "credit":
            credits = float(row["total"] or 0)
        if row["direction"] == "debit":
            debits = float(row["total"] or 0)
    monthly_capacity = round(max(credits - debits, 0), 2)

    goal_gap = round(max(normalized_target - current_savings, 0), 2)
    monthly_contribution = (
        round(ceil((goal_gap * 100) / months) / 100, 2) if goal_gap > 0 else 0.0
    )
    projected_total = round(current_savings + monthly_contribution * months, 2)
    within_cashflow = monthly_contribution <= monthly_capacity if monthly_capacity > 0 else goal_gap == 0

    schedule = [
        {
            "month": _month_after(month_value, offset),
            "contribution": monthly_contribution,
            "projected_total": round(current_savings + monthly_contribution * (offset + 1), 2),
        }
        for offset in range(months)
    ]

    return {
        "month": month_value,
        "target_amount": normalized_target,
        "months": months,
        "savings_account": str(savings_row["name"]),
        "current_savings": current_savings,
        "goal_gap": goal_gap,
        "monthly_contribution": monthly_contribution,
        "projected_total": projected_total,
        "monthly_capacity": monthly_capacity,
        "within_cashflow": within_cashflow,
        "already_reached": goal_gap == 0,
        "target_month": schedule[-1]["month"] if schedule else month_value,
        "schedule": schedule,
    }


@tool
def add_mock_transaction(
    account_name: str,
    amount: float,
    category: str,
    merchant: str,
    transaction_date: str,
    direction: str = "debit",
    note: str | None = None,
) -> dict[str, Any]:
    """Ajoute une transaction fictive dans SQLite et met a jour le solde du compte."""
    if amount <= 0:
        raise ValueError("Le montant doit etre strictement positif.")
    if direction not in {"debit", "credit"}:
        raise ValueError("direction doit valoir 'debit' ou 'credit'.")

    with _connect() as conn:
        account_id = _get_account_id(conn, account_name)
        conn.execute(
            """
            INSERT INTO transactions (
                account_id, transaction_date, direction, amount, category, merchant, note
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                transaction_date,
                direction,
                float(amount),
                category,
                merchant,
                note,
            ),
        )
        delta = float(amount) if direction == "credit" else -float(amount)
        conn.execute(
            """
            UPDATE accounts
            SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (delta, account_id),
        )
        balance_row = conn.execute(
            "SELECT ROUND(balance, 2) AS balance FROM accounts WHERE id = ?",
            (account_id,),
        ).fetchone()
        tx_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()

    return {
        "transaction_id": int(tx_id["id"]) if tx_id else None,
        "account_name": account_name,
        "new_balance": float(balance_row["balance"] or 0) if balance_row else None,
    }


@tool
def transfer_between_accounts(
    from_account: str,
    to_account: str,
    amount: float,
    label: str = "Transfert interne",
    transaction_date: str | None = None,
) -> dict[str, Any]:
    """Effectue un transfert fictif entre deux comptes et persiste les ecritures."""
    if from_account == to_account:
        raise ValueError("Les comptes source et destination doivent etre differents.")
    if amount <= 0:
        raise ValueError("Le montant doit etre strictement positif.")

    tx_date = transaction_date or date.today().isoformat()

    with _connect() as conn:
        from_id = _get_account_id(conn, from_account)
        to_id = _get_account_id(conn, to_account)

        conn.execute(
            """
            INSERT INTO transactions (
                account_id, transaction_date, direction, amount, category, merchant, note
            ) VALUES (?, ?, 'debit', ?, 'transfer', ?, ?)
            """,
            (from_id, tx_date, float(amount), "PFM Transfer", label),
        )
        out_tx_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()

        conn.execute(
            """
            INSERT INTO transactions (
                account_id, transaction_date, direction, amount, category, merchant, note
            ) VALUES (?, ?, 'credit', ?, 'transfer', ?, ?)
            """,
            (to_id, tx_date, float(amount), "PFM Transfer", label),
        )
        in_tx_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()

        conn.execute(
            "UPDATE accounts SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (float(amount), from_id),
        )
        conn.execute(
            "UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (float(amount), to_id),
        )

        balances = conn.execute(
            """
            SELECT name, ROUND(balance, 2) AS balance
            FROM accounts
            WHERE id IN (?, ?)
            ORDER BY name
            """,
            (from_id, to_id),
        ).fetchall()

    return {
        "from_account_transaction_id": int(out_tx_id["id"]) if out_tx_id else None,
        "to_account_transaction_id": int(in_tx_id["id"]) if in_tx_id else None,
        "balances": _rows_to_dicts(balances),
    }


BANKING_TOOLS = [
    list_accounts,
    list_recent_transactions,
    get_spending_by_category,
    get_cashflow_summary,
    get_budget_status,
    reallocate_budget,
    simulate_savings_goal,
    add_mock_transaction,
    transfer_between_accounts,
]


initialize_demo_database()
