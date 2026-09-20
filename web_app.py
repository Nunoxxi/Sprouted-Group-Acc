from __future__ import annotations

import os
import sqlite3
from functools import wraps
from pathlib import Path

from flask import Flask, flash, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional for local dev when dependency is not installed yet
    def load_dotenv(*args, **kwargs):
        return False

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = BASE_DIR / "sprouted_web.db"
TEST_DATABASE_PATH = BASE_DIR / "sprouted_web_test.db"
ACTIVE_DATABASE_PATH = DATABASE_PATH
load_dotenv(BASE_DIR / ".env", override=False)

ROLE_PERMISSIONS = {
    "admin": {"dashboard", "companies", "reports", "users", "companies_add", "transactions"},
    "accountant": {"dashboard", "companies", "reports", "companies_add", "transactions"},
    "manager": {"dashboard", "companies", "reports", "companies_add", "transactions"},
    "viewer": {"dashboard", "companies", "reports", "transactions"},
}

DEFAULT_ACCOUNT_TEMPLATES = {
    "NFP": [
        ("101", "Cash", "asset", "Current Assets", "Operating cash held by the charity."),
        ("110", "Accounts Receivable", "asset", "Current Assets", "Amounts due from donors or grant partners."),
        ("200", "Donations Received", "revenue", "Revenue", "Restricted and unrestricted donations received."),
        ("210", "Grant Income", "revenue", "Revenue", "Grant and donor project income."),
        ("300", "Program Expenses", "expense", "Program Costs", "Direct costs for beneficiaries and projects."),
        ("310", "Administration Expenses", "expense", "Operating Costs", "Support costs and overheads."),
        ("400", "Restricted Funds", "equity", "Fund Balance", "Funds restricted to a programme or donor purpose."),
        ("410", "Unrestricted Net Assets", "equity", "Fund Balance", "General operating surplus or deficit."),
    ],
    "LLC": [
        ("101", "Cash", "asset", "Current Assets", "Operating cash in the business account."),
        ("110", "Accounts Receivable", "asset", "Current Assets", "Amounts due from customers."),
        ("200", "Revenue", "revenue", "Income", "Sales and service income."),
        ("300", "Operating Expenses", "expense", "Operating Costs", "General business operating costs."),
        ("400", "Owner Equity", "equity", "Equity", "Owner investment and retained earnings."),
    ],
}


def get_role_permissions(role: str | None) -> dict[str, bool]:
    normalized = (role or "viewer").strip().lower()
    defaults = {
        "admin": {"can_view_reports": True, "can_add_transactions": True, "can_manage_users": True},
        "accountant": {"can_view_reports": True, "can_add_transactions": True, "can_manage_users": False},
        "manager": {"can_view_reports": True, "can_add_transactions": True, "can_manage_users": False},
        "viewer": {"can_view_reports": True, "can_add_transactions": False, "can_manage_users": False},
    }
    return defaults.get(normalized, defaults["viewer"]).copy()


def get_runtime_config():
    supabase_url = (os.getenv("SUPABASE_URL") or "").strip()
    anon_key = (os.getenv("SUPABASE_ANON_KEY") or "").strip()
    service_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()

    return {
        "database_backend": "supabase" if bool(supabase_url and (anon_key or service_key)) else "sqlite",
        "supabase_url": supabase_url,
        "supabase_anon_key": anon_key,
        "supabase_service_role_key": service_key,
        "secret_key": (os.getenv("SECRET_KEY") or "sprouted-secret-key").strip(),
    }


def normalize_company_type(company_type: str | None) -> str:
    normalized = (company_type or "").strip()
    lookup = normalized.lower()
    if lookup in {"charity", "non-profit", "non_profit", "nonprofit", "nfp"}:
        return "NFP"
    if lookup in {"llc", "l.l.c.", "limited liability company"}:
        return "LLC"
    return normalized or "LLC"


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(ACTIVE_DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, definition: str) -> None:
    existing_columns = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    if not any(row[1] == column_name for row in existing_columns):
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def init_db() -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL
        )
        """
    )
    ensure_column(conn, "users", "email", "TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            company_type TEXT NOT NULL,
            code TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            entry_type TEXT NOT NULL,
            project_name TEXT NOT NULL DEFAULT 'General Operations',
            fund_type TEXT NOT NULL DEFAULT 'unrestricted',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, name),
            UNIQUE(company_id, code),
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            project_name TEXT NOT NULL,
            fund_type TEXT NOT NULL DEFAULT 'unrestricted',
            budget_amount REAL NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, project_name, fund_type),
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_type TEXT NOT NULL,
            account_code TEXT NOT NULL,
            account_name TEXT NOT NULL,
            account_type TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            is_default INTEGER NOT NULL DEFAULT 1,
            UNIQUE(company_type, account_code)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS company_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            account_code TEXT NOT NULL,
            account_name TEXT NOT NULL,
            account_type TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            is_default INTEGER NOT NULL DEFAULT 1,
            is_active INTEGER NOT NULL DEFAULT 1,
            UNIQUE(company_id, account_code),
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_company_access (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            can_view_reports INTEGER NOT NULL DEFAULT 1,
            can_add_transactions INTEGER NOT NULL DEFAULT 0,
            can_manage_users INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            UNIQUE(user_id, company_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )

    ensure_column(conn, "transactions", "project_name", "TEXT NOT NULL DEFAULT 'General Operations'")
    ensure_column(conn, "transactions", "fund_type", "TEXT NOT NULL DEFAULT 'unrestricted'")

    conn.execute("UPDATE companies SET company_type = 'NFP' WHERE lower(company_type) IN ('charity', 'non-profit', 'non_profit', 'nonprofit', 'nfp')")
    conn.execute("UPDATE companies SET company_type = 'LLC' WHERE lower(company_type) IN ('llc', 'l.l.c.', 'limited liability company')")

    default_users = [
        ("admin", "admin@sproutedgroup.com", generate_password_hash("admin123"), "admin"),
        ("accountant", "accountant@sproutedgroup.com", generate_password_hash("accountant123"), "accountant"),
        ("manager", "manager@sproutedgroup.com", generate_password_hash("manager123"), "manager"),
        ("viewer", "viewer@sproutedgroup.com", generate_password_hash("viewer123"), "viewer"),
    ]

    for username, email, password_hash, role in default_users:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if existing is None:
            existing_by_email = conn.execute(
                "SELECT id FROM users WHERE lower(email) = lower(?)",
                (email,),
            ).fetchone()
            if existing_by_email is None:
                conn.execute(
                    "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
                    (username, email, password_hash, role),
                )
        else:
            current_email = conn.execute(
                "SELECT email FROM users WHERE id = ?",
                (existing["id"],),
            ).fetchone()
            if current_email is None or (current_email["email"] or "").strip() == "":
                conn.execute(
                    "UPDATE users SET email = ? WHERE id = ?",
                    (email, existing["id"]),
                )

    seen_emails = {}
    rows = conn.execute("SELECT id, username, email FROM users ORDER BY id").fetchall()
    for row in rows:
        chosen_email = (row["email"] or "").strip() or f"{row['username']}@sproutedgroup.com"
        base_email = chosen_email
        suffix = 1
        while chosen_email in seen_emails:
            local_part, domain = base_email.split("@", 1)
            chosen_email = f"{local_part}+{suffix}@{domain}"
            suffix += 1
        seen_emails[chosen_email] = row["id"]
        if chosen_email != (row["email"] or "").strip():
            conn.execute(
                "UPDATE users SET email = ? WHERE id = ?",
                (chosen_email, row["id"]),
            )

    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")

    default_companies = [
        ("Sprouted Roots", "NFP", "SG001"),
        ("Sprouted Crafts", "LLC", "SG002"),
        ("Oikazi", "LLC", "SG003"),
    ]
    legacy_company_names = ("Sprouted Assets", "Sprouted Services", "Sprouted Digital", "Sprouted Horizon")

    if legacy_company_names:
        placeholders = ", ".join("?" for _ in legacy_company_names)
        conn.execute(f"DELETE FROM companies WHERE name IN ({placeholders})", legacy_company_names)

    for company_name, company_type, company_code in default_companies:
        existing_company = conn.execute(
            "SELECT id FROM companies WHERE code = ? OR name = ?",
            (company_code, company_name),
        ).fetchone()
        if existing_company is None:
            conn.execute(
                "INSERT INTO companies (name, company_type, code) VALUES (?, ?, ?)",
                (company_name, company_type, company_code),
            )

    for company_type in ("NFP", "LLC"):
        for account_code, account_name, account_type, category, description in DEFAULT_ACCOUNT_TEMPLATES.get(company_type, []):
            existing_template = conn.execute(
                "SELECT id FROM account_templates WHERE company_type = ? AND account_code = ?",
                (company_type, account_code),
            ).fetchone()
            if existing_template is None:
                conn.execute(
                    "INSERT INTO account_templates (company_type, account_code, account_name, account_type, category, description, is_default) VALUES (?, ?, ?, ?, ?, ?, 1)",
                    (company_type, account_code, account_name, account_type, category, description),
                )

    company_rows = conn.execute("SELECT id, name, company_type FROM companies ORDER BY id").fetchall()
    for company_row in company_rows:
        default_projects = ["General Operations"]
        if company_row["company_type"] == "NFP":
            default_projects = [
                "General Operations",
                "Youth Education Programme",
                "Community Outreach Programme",
                "Health & Wellbeing Programme",
            ]
        for index, project_name in enumerate(default_projects):
            project_code = f"P{project_name[:3].upper()}{company_row['id']}{index + 1}"
            existing_project = conn.execute(
                "SELECT id FROM projects WHERE company_id = ? AND name = ?",
                (company_row["id"], project_name),
            ).fetchone()
            if existing_project is None:
                conn.execute(
                    "INSERT INTO projects (company_id, name, code) VALUES (?, ?, ?)",
                    (company_row["id"], project_name, project_code),
                )

        for account_code, account_name, account_type, category, description in DEFAULT_ACCOUNT_TEMPLATES.get(company_row["company_type"], []):
            existing_row = conn.execute(
                "SELECT id FROM company_accounts WHERE company_id = ? AND account_code = ?",
                (company_row["id"], account_code),
            ).fetchone()
            if existing_row is None:
                conn.execute(
                    "INSERT INTO company_accounts (company_id, account_code, account_name, account_type, category, description, is_default, is_active) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
                    (company_row["id"], account_code, account_name, account_type, category, description),
                )

    for user_row in conn.execute("SELECT id, role FROM users ORDER BY id").fetchall():
        access_details = get_role_permissions(user_row["role"])
        access_details["role"] = user_row["role"]
        for company_row in company_rows:
            existing_access = conn.execute(
                "SELECT id FROM user_company_access WHERE user_id = ? AND company_id = ?",
                (user_row["id"], company_row["id"]),
            ).fetchone()
            if existing_access is None:
                conn.execute(
                    """
                    INSERT INTO user_company_access (
                        user_id, company_id, role, can_view_reports, can_add_transactions, can_manage_users, is_active
                    ) VALUES (?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        user_row["id"],
                        company_row["id"],
                        access_details["role"],
                        int(access_details["can_view_reports"]),
                        int(access_details["can_add_transactions"]),
                        int(access_details["can_manage_users"]),
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE user_company_access
                    SET role = ?, can_view_reports = ?, can_add_transactions = ?, can_manage_users = ?, is_active = 1
                    WHERE user_id = ? AND company_id = ?
                    """,
                    (
                        access_details["role"],
                        int(access_details["can_view_reports"]),
                        int(access_details["can_add_transactions"]),
                        int(access_details["can_manage_users"]),
                        user_row["id"],
                        company_row["id"],
                    ),
                )

    conn.commit()
    conn.close()


def get_user_by_email(email: str):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE lower(email) = lower(?)",
        (email,),
    ).fetchone()
    conn.close()
    return user


def get_user_by_username(username: str):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE lower(username) = lower(?)",
        (username,),
    ).fetchone()
    conn.close()
    return user


def get_user_by_identifier(identifier: str):
    identifier = (identifier or "").strip()
    if not identifier:
        return None
    user = get_user_by_email(identifier)
    if user is not None:
        return user
    return get_user_by_username(identifier)


def get_user_by_id(user_id: int):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    return user


def get_user_company_accesses(user_id: int):
    conn = get_db()
    rows = conn.execute(
        """
        SELECT uca.*, c.name AS company_name
        FROM user_company_access uca
        JOIN companies c ON c.id = uca.company_id
        WHERE uca.user_id = ? AND uca.is_active = 1
        ORDER BY c.name
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    return rows


def upsert_user_company_access(user_id: int, company_id: int, role: str, can_view_reports: bool, can_add_transactions: bool, can_manage_users: bool):
    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM user_company_access WHERE user_id = ? AND company_id = ?",
        (user_id, company_id),
    ).fetchone()

    insert_values = (
        user_id,
        company_id,
        role,
        int(bool(can_view_reports)),
        int(bool(can_add_transactions)),
        int(bool(can_manage_users)),
        1,
    )

    if existing is None:
        conn.execute(
            """
            INSERT INTO user_company_access (user_id, company_id, role, can_view_reports, can_add_transactions, can_manage_users, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            insert_values,
        )
    else:
        conn.execute(
            """
            UPDATE user_company_access
            SET role = ?, can_view_reports = ?, can_add_transactions = ?, can_manage_users = ?, is_active = ?
            WHERE user_id = ? AND company_id = ?
            """,
            (
                role,
                int(bool(can_view_reports)),
                int(bool(can_add_transactions)),
                int(bool(can_manage_users)),
                1,
                user_id,
                company_id,
            ),
        )

    conn.commit()
    conn.close()


def get_user_companies(user_id: int):
    conn = get_db()
    rows = conn.execute(
        """
        SELECT c.*
        FROM companies c
        INNER JOIN user_company_access uca ON uca.company_id = c.id
        WHERE uca.user_id = ? AND uca.is_active = 1
        ORDER BY c.name
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    return rows


def get_default_account_templates(company_type: str | None):
    normalized = (company_type or "").strip().upper()
    templates = DEFAULT_ACCOUNT_TEMPLATES.get(normalized, [])
    return [
        {
            "account_code": account_code,
            "account_name": account_name,
            "account_type": account_type,
            "category": category,
            "description": description,
        }
        for account_code, account_name, account_type, category, description in templates
    ]


def get_company_accounts(company_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM company_accounts WHERE company_id = ? AND is_active = 1 ORDER BY CAST(account_code AS INTEGER), account_name",
        (company_id,),
    ).fetchall()
    conn.close()
    return rows


def seed_company_chart_of_accounts(company_id: int, company_type: str | None):
    normalized = (company_type or "").strip().upper()
    templates = get_default_account_templates(normalized)
    conn = get_db()
    for template in templates:
        existing = conn.execute(
            "SELECT id FROM company_accounts WHERE company_id = ? AND account_code = ?",
            (company_id, template["account_code"]),
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO company_accounts (company_id, account_code, account_name, account_type, category, description, is_default, is_active) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
                (
                    company_id,
                    template["account_code"],
                    template["account_name"],
                    template["account_type"],
                    template["category"],
                    template["description"],
                ),
            )
    conn.commit()
    conn.close()


def get_projects_for_company(company_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM projects WHERE company_id = ? ORDER BY name",
        (company_id,),
    ).fetchall()
    conn.close()
    return rows


def ensure_project_for_company(company_id: int, project_name: str | None):
    cleaned = (project_name or "").strip()
    if not cleaned:
        cleaned = "General Operations"
    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM projects WHERE company_id = ? AND name = ?",
        (company_id, cleaned),
    ).fetchone()
    if existing is None:
        company = conn.execute("SELECT company_type FROM companies WHERE id = ?", (company_id,)).fetchone()
        project_code = f"P{cleaned[:3].upper()}{company_id}"
        conn.execute(
            "INSERT INTO projects (company_id, name, code) VALUES (?, ?, ?)",
            (company_id, cleaned, project_code),
        )
        conn.commit()
    conn.close()
    return cleaned


def get_user_company_access(user_id: int, company_id: int):
    conn = get_db()
    access = conn.execute(
        """
        SELECT * FROM user_company_access
        WHERE user_id = ? AND company_id = ?
        """,
        (user_id, company_id),
    ).fetchone()
    conn.close()
    return access


def user_has_permission(user_id: int, company_id: int | None, permission_name: str) -> bool:
    if company_id is None:
        return False

    user = get_user_by_id(user_id)
    if user and user["role"] == "admin":
        return True

    access = get_user_company_access(user_id, company_id)
    if access is None:
        return False
    value = access[permission_name]
    return bool(value)


def get_selected_company_for_user(user_id: int):
    companies = get_user_companies(user_id)
    if not companies:
        conn = get_db()
        legacy = conn.execute("SELECT * FROM companies ORDER BY name LIMIT 1").fetchone()
        conn.close()
        return legacy
    return companies[0]


def login_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if "user_id" not in session:
            flash("Please log in first.", "warning")
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped_view


def role_required(*allowed_roles):
    def decorator(view):
        @wraps(view)
        def wrapped_view(*args, **kwargs):
            if "user_id" not in session:
                flash("Please log in first.", "warning")
                return redirect(url_for("login"))

            user = get_user_by_id(session["user_id"])
            if user is None or user["role"] not in allowed_roles:
                flash("You do not have access to this page.", "danger")
                return ("Access denied", 403)
            return view(*args, **kwargs)

        return wrapped_view

    return decorator


def get_dashboard_summary(company_id: int | None = None):
    conn = get_db()
    if company_id is not None:
        companies = conn.execute("SELECT * FROM companies WHERE id = ? ORDER BY name", (company_id,)).fetchall()
        transactions = conn.execute(
            "SELECT company_id, entry_type, SUM(amount) AS total FROM transactions WHERE company_id = ? GROUP BY company_id, entry_type",
            (company_id,),
        ).fetchall()
    else:
        companies = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        transactions = conn.execute(
            "SELECT company_id, entry_type, SUM(amount) AS total FROM transactions GROUP BY company_id, entry_type"
        ).fetchall()
    conn.close()

    totals = {}
    for row in transactions:
        company_id_value = row["company_id"]
        totals.setdefault(company_id_value, {"income": 0.0, "expense": 0.0})
        totals[company_id_value][row["entry_type"]] = float(row["total"] or 0)

    summary = []
    for company in companies:
        income = totals.get(company["id"], {}).get("income", 0.0)
        expense = totals.get(company["id"], {}).get("expense", 0.0)
        summary.append(
            {
                "company": company,
                "income": income,
                "expense": expense,
                "net": income - expense,
            }
        )

    return summary


def get_dashboard_kpis(summary):
    total_companies = len(summary)
    total_income = sum(item["income"] for item in summary)
    total_expense = sum(item["expense"] for item in summary)
    total_net = total_income - total_expense

    return {
        "companies": total_companies,
        "income": total_income,
        "expense": total_expense,
        "net": total_net,
    }


def get_recent_transactions(limit: int = 6, company_id: int | None = None):
    conn = get_db()
    if company_id is not None:
        rows = conn.execute(
            """
            SELECT t.*, c.name AS company_name
            FROM transactions t
            JOIN companies c ON c.id = t.company_id
            WHERE t.company_id = ?
            ORDER BY t.created_at DESC
            LIMIT ?
            """,
            (company_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT t.*, c.name AS company_name
            FROM transactions t
            JOIN companies c ON c.id = t.company_id
            ORDER BY t.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    conn.close()
    return rows


def get_project_summary(company_id: int | None = None):
    conn = get_db()
    if company_id is None:
        rows = conn.execute(
            """
            SELECT project_name, fund_type,
                   SUM(CASE WHEN entry_type = 'income' THEN amount ELSE 0 END) AS income,
                   SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END) AS expense
            FROM transactions
            GROUP BY project_name, fund_type
            ORDER BY project_name, fund_type
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT project_name, fund_type,
                   SUM(CASE WHEN entry_type = 'income' THEN amount ELSE 0 END) AS income,
                   SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END) AS expense
            FROM transactions
            WHERE company_id = ?
            GROUP BY project_name, fund_type
            ORDER BY project_name, fund_type
            """,
            (company_id,),
        ).fetchall()
    conn.close()

    project_rows = []
    for row in rows:
        income = float(row["income"] or 0)
        expense = float(row["expense"] or 0)
        project_rows.append({
            "project_name": row["project_name"] or "General Operations",
            "fund_type": row["fund_type"] or "unrestricted",
            "income": income,
            "expense": expense,
            "net": income - expense,
        })
    return project_rows


def get_project_budget_summary(company_id: int | None = None):
    conn = get_db()
    if company_id is None:
        rows = conn.execute(
            "SELECT * FROM project_budgets ORDER BY project_name, fund_type"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM project_budgets WHERE company_id = ? ORDER BY project_name, fund_type",
            (company_id,),
        ).fetchall()
    conn.close()
    return [
        {
            "company_id": row["company_id"],
            "project_name": row["project_name"],
            "fund_type": row["fund_type"],
            "budget_amount": float(row["budget_amount"] or 0),
        }
        for row in rows
    ]


def create_app(testing: bool = False):
    app = Flask(__name__)
    global ACTIVE_DATABASE_PATH
    ACTIVE_DATABASE_PATH = TEST_DATABASE_PATH if testing else DATABASE_PATH

    runtime_config = get_runtime_config()
    app.config["SECRET_KEY"] = runtime_config["secret_key"]
    app.config["DATABASE_BACKEND"] = runtime_config["database_backend"]
    app.config["TESTING"] = testing
    app.config["DATABASE_PATH"] = ACTIVE_DATABASE_PATH

    init_db()

    def ensure_company_context(user_id: int):
        company = get_selected_company_for_user(user_id)
        if company is not None:
            session["company_id"] = company["id"]
            session["company_name"] = company["name"]
        return company

    @app.route("/")
    def index():
        if "user_id" in session:
            return redirect(url_for("dashboard"))
        return redirect(url_for("login"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            email_or_username = request.form.get("email") or request.form.get("username") or request.form.get("identifier", "")
            email_or_username = email_or_username.strip()
            password = request.form.get("password", "")
            user = get_user_by_identifier(email_or_username)
            if user and check_password_hash(user["password_hash"], password):
                session["user_id"] = user["id"]
                session["username"] = user["username"]
                session["email"] = user["email"] or user["username"]
                session["role"] = user["role"]
                ensure_company_context(user["id"])
                flash("Login successful.", "success")
                return redirect(url_for("dashboard"))
            flash("Invalid email or password.", "danger")

        return render_template("login.html")

    @app.route("/logout")
    def logout():
        session.clear()
        flash("You have been logged out.", "info")
        return redirect(url_for("login"))

    @app.route("/dashboard")
    @login_required
    def dashboard():
        user = get_user_by_id(session["user_id"])
        selected_company_id = session.get("company_id")
        user_companies = get_user_companies(session["user_id"])
        if selected_company_id is None and user_companies:
            selected_company_id = user_companies[0]["id"]
            session["company_id"] = selected_company_id
            session["company_name"] = user_companies[0]["name"]
        summary = get_dashboard_summary(selected_company_id)
        kpis = get_dashboard_kpis(summary)
        recent_transactions = get_recent_transactions(company_id=selected_company_id)
        return render_template(
            "dashboard.html",
            user=user,
            summary=summary,
            kpis=kpis,
            recent_transactions=recent_transactions,
            user_companies=user_companies,
            selected_company_id=selected_company_id,
        )

    @app.route("/companies")
    @login_required
    def companies():
        user_id = session["user_id"]
        user_companies = get_user_companies(user_id)
        selected_company_id = session.get("company_id")

        requested_company_id = request.args.get("company_id")
        if requested_company_id is not None:
            requested_company_id = int(requested_company_id)
            if any(company["id"] == requested_company_id for company in user_companies):
                selected_company_id = requested_company_id
                session["company_id"] = selected_company_id
                session["company_name"] = next(company["name"] for company in user_companies if company["id"] == requested_company_id)

        if selected_company_id is None and user_companies:
            selected_company_id = user_companies[0]["id"]
            session["company_id"] = selected_company_id
            session["company_name"] = user_companies[0]["name"]

        conn = get_db()
        rows = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        conn.close()
        return render_template("companies.html", companies=rows, user_companies=user_companies, selected_company_id=selected_company_id)

    @app.route("/companies/select/<int:company_id>")
    @login_required
    def select_company(company_id):
        user_companies = get_user_companies(session["user_id"])
        company_exists = any(company["id"] == company_id for company in user_companies)
        if not company_exists:
            flash("You do not have access to that company.", "danger")
            return redirect(url_for("companies"))

        company = next(company for company in user_companies if company["id"] == company_id)
        session["company_id"] = company_id
        session["company_name"] = company["name"]
        flash(f"Company switched to {company['name']}.", "info")
        return redirect(url_for("dashboard"))

    @app.route("/companies/add", methods=["GET", "POST"])
    @login_required
    def companies_add():
        user_id = session["user_id"]
        user = get_user_by_id(user_id)
        if user is None or user["role"] not in {"admin", "accountant", "manager"}:
            flash("You do not have permission to add companies.", "danger")
            return ("Access denied", 403)

        if request.method == "POST":
            name = request.form.get("name", "").strip()
            company_type = normalize_company_type(request.form.get("company_type"))
            code = request.form.get("code", "").strip().upper()

            if not name or not company_type or not code:
                flash("Please complete all fields.", "danger")
                return render_template("company_form.html")

            conn = get_db()
            try:
                conn.execute(
                    "INSERT INTO companies (name, company_type, code) VALUES (?, ?, ?)",
                    (name, company_type, code),
                )
                conn.commit()
                company_id = conn.execute("SELECT id FROM companies WHERE code = ?", (code,)).fetchone()["id"]
                seed_company_chart_of_accounts(company_id, company_type)
                flash(f"Company '{name}' added successfully.", "success")
            except sqlite3.IntegrityError:
                flash("A company with this code already exists.", "danger")
            finally:
                conn.close()

            return redirect(url_for("companies"))

        return render_template("company_form.html")

    @app.route("/transactions", methods=["GET", "POST"])
    @login_required
    def transactions():
        user_companies = get_user_companies(session["user_id"])
        selected_company_id = session.get("company_id") or (user_companies[0]["id"] if user_companies else None)

        conn = get_db()
        companies = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        if request.method == "POST":
            company_id = request.form.get("company_id") or selected_company_id
            description = request.form.get("description", "").strip()
            amount = request.form.get("amount", "0").strip()
            entry_type = request.form.get("entry_type", "income").strip().lower()
            project_name = request.form.get("project_name", "General Operations").strip() or "General Operations"
            fund_type = request.form.get("fund_type", "unrestricted").strip().lower() or "unrestricted"
            if fund_type not in {"restricted", "unrestricted"}:
                fund_type = "unrestricted"

            if not user_has_permission(session["user_id"], int(company_id) if company_id else None, "can_add_transactions"):
                flash("You do not have permission to add transactions for this company.", "danger")
                return ("Access denied", 403)

            if company_id and description and amount:
                ensure_project_for_company(int(company_id), project_name)
                conn.execute(
                    "INSERT INTO transactions (company_id, description, amount, entry_type, project_name, fund_type) VALUES (?, ?, ?, ?, ?, ?)",
                    (int(company_id), description, float(amount), entry_type, project_name, fund_type),
                )
                conn.commit()
                flash("Transaction recorded.", "success")
                session["company_id"] = int(company_id)
                return redirect(url_for("transactions"))

            flash("Please fill in all transaction fields.", "danger")

        if selected_company_id is not None:
            project_options = get_projects_for_company(selected_company_id)
        else:
            project_options = []

        rows = conn.execute(
            "SELECT t.*, c.name AS company_name FROM transactions t JOIN companies c ON c.id = t.company_id WHERE t.company_id = ? ORDER BY t.created_at DESC",
            (selected_company_id,) if selected_company_id is not None else (0,),
        ).fetchall() if selected_company_id is not None else []
        conn.close()
        if selected_company_id is not None:
            session["company_id"] = selected_company_id
        return render_template("transactions.html", companies=companies, transactions=rows, selected_company_id=selected_company_id, user_companies=user_companies, project_options=project_options)

    @app.route("/accounts")
    @login_required
    def accounts():
        user_companies = get_user_companies(session["user_id"])
        selected_company_id = session.get("company_id") or (user_companies[0]["id"] if user_companies else None)

        if selected_company_id is None:
            return render_template("accounts.html", selected_company_id=None, user_companies=user_companies, accounts=[], project_options=[])

        selected_company = next((company for company in user_companies if company["id"] == selected_company_id), None)
        company_accounts = get_company_accounts(selected_company_id)
        project_options = get_projects_for_company(selected_company_id)

        if selected_company is not None:
            company_type = selected_company["company_type"]
            if not company_accounts:
                seed_company_chart_of_accounts(selected_company_id, company_type)
                company_accounts = get_company_accounts(selected_company_id)

        return render_template("accounts.html", selected_company_id=selected_company_id, user_companies=user_companies, accounts=company_accounts, project_options=project_options, company=selected_company)

    @app.route("/budgets", methods=["GET", "POST"])
    @login_required
    def budgets():
        user_companies = get_user_companies(session["user_id"])
        selected_company_id = session.get("company_id") or (user_companies[0]["id"] if user_companies else None)

        conn = get_db()
        if request.method == "POST":
            company_id = request.form.get("company_id") or selected_company_id
            project_name = request.form.get("project_name", "General Operations").strip() or "General Operations"
            fund_type = request.form.get("fund_type", "unrestricted").strip().lower() or "unrestricted"
            budget_amount = request.form.get("budget_amount", "0").strip()

            if not user_has_permission(session["user_id"], int(company_id) if company_id else None, "can_add_transactions"):
                flash("You do not have permission to set budgets for this company.", "danger")
                return ("Access denied", 403)

            if company_id and project_name and budget_amount:
                ensure_project_for_company(int(company_id), project_name)
                existing = conn.execute(
                    "SELECT id FROM project_budgets WHERE company_id = ? AND project_name = ? AND fund_type = ?",
                    (int(company_id), project_name, fund_type),
                ).fetchone()
                if existing is None:
                    conn.execute(
                        "INSERT INTO project_budgets (company_id, project_name, fund_type, budget_amount) VALUES (?, ?, ?, ?)",
                        (int(company_id), project_name, fund_type, float(budget_amount)),
                    )
                else:
                    conn.execute(
                        "UPDATE project_budgets SET budget_amount = ? WHERE id = ?",
                        (float(budget_amount), existing["id"]),
                    )
                conn.commit()
                flash("Project budget saved.", "success")
                session["company_id"] = int(company_id)
                return redirect(url_for("budgets"))

            flash("Please fill in all budget fields.", "danger")

        budgets = get_project_budget_summary(selected_company_id)
        project_options = get_projects_for_company(selected_company_id) if selected_company_id is not None else []
        conn.close()
        return render_template("budgets.html", budgets=budgets, selected_company_id=selected_company_id, user_companies=user_companies, project_options=project_options)

    @app.route("/reports")
    @login_required
    def reports():
        selected_company_id = session.get("company_id")
        user_companies = get_user_companies(session["user_id"])
        if selected_company_id is None and user_companies:
            selected_company_id = user_companies[0]["id"]
            session["company_id"] = selected_company_id
            session["company_name"] = user_companies[0]["name"]
        summary = get_dashboard_summary(selected_company_id)
        project_summary = get_project_summary(selected_company_id)
        budget_summary = get_project_budget_summary(selected_company_id)
        return render_template("reports.html", summary=summary, project_summary=project_summary, budget_summary=budget_summary, selected_company_id=selected_company_id, user_companies=user_companies)

    @app.route("/users")
    @login_required
    @role_required("admin")
    def users():
        conn = get_db()
        rows = conn.execute("SELECT * FROM users ORDER BY username").fetchall()
        conn.close()
        users_with_access = []
        for user in rows:
            users_with_access.append({
                "user": {key: user[key] for key in user.keys()},
                "access": get_user_company_accesses(user["id"]),
            })
        return render_template("users.html", users=users_with_access)

    @app.route("/users/<int:user_id>/access", methods=["GET", "POST"])
    @login_required
    @role_required("admin")
    def user_access(user_id):
        user = get_user_by_id(user_id)
        if user is None:
            flash("User not found.", "danger")
            return redirect(url_for("users"))

        conn = get_db()
        companies = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        conn.close()

        if request.method == "POST":
            company_id = request.form.get("company_id")
            role = request.form.get("role", "viewer").strip().lower()
            defaults = get_role_permissions(role)
            can_view_reports = request.form.get("can_view_reports") == "on" if "can_view_reports" in request.form else defaults["can_view_reports"]
            can_add_transactions = request.form.get("can_add_transactions") == "on" if "can_add_transactions" in request.form else defaults["can_add_transactions"]
            can_manage_users = request.form.get("can_manage_users") == "on" if "can_manage_users" in request.form else defaults["can_manage_users"]

            if company_id is None or company_id == "":
                flash("Please select a company.", "danger")
                return redirect(url_for("user_access", user_id=user_id))

            upsert_user_company_access(
                user_id=user_id,
                company_id=int(company_id),
                role=role,
                can_view_reports=can_view_reports,
                can_add_transactions=can_add_transactions,
                can_manage_users=can_manage_users,
            )
            flash("Access updated.", "success")
            return redirect(url_for("users"))

        access_rows = get_user_company_accesses(user_id)
        access_map = {row["company_id"]: row for row in access_rows}
        return render_template("user_access.html", user=user, companies=companies, access_map=access_map)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
