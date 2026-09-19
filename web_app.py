from __future__ import annotations

import os
import sqlite3
from functools import wraps
from pathlib import Path

from flask import Flask, flash, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = BASE_DIR / "sprouted_web.db"

ROLE_PERMISSIONS = {
    "admin": {"dashboard", "companies", "reports", "users", "companies_add", "transactions"},
    "accountant": {"dashboard", "companies", "reports", "companies_add", "transactions"},
    "manager": {"dashboard", "companies", "reports"},
    "viewer": {"dashboard", "companies", "reports"},
}


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL
        )
        """
    )
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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        )
        """
    )

    default_users = [
        ("admin", generate_password_hash("admin123"), "admin"),
        ("accountant", generate_password_hash("accountant123"), "accountant"),
        ("manager", generate_password_hash("manager123"), "manager"),
        ("viewer", generate_password_hash("viewer123"), "viewer"),
    ]

    for username, password_hash, role in default_users:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                (username, password_hash, role),
            )

    if conn.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0:
        default_companies = [
            ("Sprouted Roots", "charity", "SR"),
            ("Sprouted Assets", "llc", "SA"),
            ("Sprouted Services", "llc", "SS"),
        ]
        conn.executemany(
            "INSERT INTO companies (name, company_type, code) VALUES (?, ?, ?)",
            default_companies,
        )

    conn.commit()
    conn.close()


def get_user_by_username(username: str):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    return user


def get_user_by_id(user_id: int):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    return user


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


def get_dashboard_summary():
    conn = get_db()
    companies = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
    transactions = conn.execute(
        "SELECT company_id, entry_type, SUM(amount) AS total FROM transactions GROUP BY company_id, entry_type"
    ).fetchall()
    conn.close()

    totals = {}
    for row in transactions:
        company_id = row["company_id"]
        totals.setdefault(company_id, {"income": 0.0, "expense": 0.0})
        totals[company_id][row["entry_type"]] = float(row["total"] or 0)

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


def get_recent_transactions(limit: int = 6):
    conn = get_db()
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


def create_app(testing: bool = False):
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "sprouted-secret-key")
    app.config["TESTING"] = testing

    init_db()

    @app.route("/")
    def index():
        if "user_id" in session:
            return redirect(url_for("dashboard"))
        return redirect(url_for("login"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            user = get_user_by_username(username)
            if user and check_password_hash(user["password_hash"], password):
                session["user_id"] = user["id"]
                session["username"] = user["username"]
                session["role"] = user["role"]
                flash("Login successful.", "success")
                return redirect(url_for("dashboard"))
            flash("Invalid username or password.", "danger")

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
        summary = get_dashboard_summary()
        kpis = get_dashboard_kpis(summary)
        recent_transactions = get_recent_transactions()
        return render_template(
            "dashboard.html",
            user=user,
            summary=summary,
            kpis=kpis,
            recent_transactions=recent_transactions,
        )

    @app.route("/companies")
    @login_required
    def companies():
        conn = get_db()
        rows = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        conn.close()
        return render_template("companies.html", companies=rows)

    @app.route("/companies/add", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "accountant")
    def companies_add():
        if request.method == "POST":
            name = request.form.get("name", "").strip()
            company_type = request.form.get("company_type", "").strip().lower()
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
                flash(f"Company '{name}' added successfully.", "success")
            except sqlite3.IntegrityError:
                flash("A company with this code already exists.", "danger")
            finally:
                conn.close()

            return redirect(url_for("companies"))

        return render_template("company_form.html")

    @app.route("/transactions", methods=["GET", "POST"])
    @login_required
    @role_required("admin", "accountant")
    def transactions():
        conn = get_db()
        companies = conn.execute("SELECT * FROM companies ORDER BY name").fetchall()
        if request.method == "POST":
            company_id = request.form.get("company_id")
            description = request.form.get("description", "").strip()
            amount = request.form.get("amount", "0").strip()
            entry_type = request.form.get("entry_type", "income").strip().lower()

            if company_id and description and amount:
                conn.execute(
                    "INSERT INTO transactions (company_id, description, amount, entry_type) VALUES (?, ?, ?, ?)",
                    (int(company_id), description, float(amount), entry_type),
                )
                conn.commit()
                flash("Transaction recorded.", "success")
                return redirect(url_for("transactions"))

            flash("Please fill in all transaction fields.", "danger")

        rows = conn.execute(
            "SELECT t.*, c.name AS company_name FROM transactions t JOIN companies c ON c.id = t.company_id ORDER BY t.created_at DESC"
        ).fetchall()
        conn.close()
        return render_template("transactions.html", companies=companies, transactions=rows)

    @app.route("/reports")
    @login_required
    def reports():
        summary = get_dashboard_summary()
        return render_template("reports.html", summary=summary)

    @app.route("/users")
    @login_required
    @role_required("admin")
    def users():
        conn = get_db()
        rows = conn.execute("SELECT * FROM users ORDER BY username").fetchall()
        conn.close()
        return render_template("users.html", users=rows)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
