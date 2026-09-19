# Sprouted Group Accounting Web App

This project is now a simple web application for the Sprouted group of companies:

- Sprouted Roots — charity
- Sprouted Assets — limited liability company
- Sprouted Services — limited liability company

The app is designed for beginner-friendly use and includes role-based access for different users.

## Roles

- Admin: full access
- Accountant: can add companies and transactions
- Manager: can view dashboards and reports
- Viewer: can view company and reporting information only

## Run the web app

```bash
python web_app.py
```

Then open the browser at:

```text
http://127.0.0.1:5000/login
```

## Demo users

- admin / admin123
- accountant / accountant123
- manager / manager123
- viewer / viewer123

## Run tests

```bash
pytest -q tests/test_web_app.py
```

## Beginner deployment roadmap

A simple and beginner-friendly way to get this app online is:

1. Put the project on GitHub
2. Use a hosted Python service such as Render or Railway for the Flask app
3. Use Supabase for the database and login backend if you want a more production-ready setup later

This project is currently using a local SQLite database, which works on your computer but is not what you want for a public online app.

### Recommended beginner path

- GitHub: store your project code
- Render or Railway: host the Flask app online
- Supabase: replace SQLite with a hosted database when you are ready

### Simple deployment notes

- Create a GitHub repository
- Push this project to GitHub
- On Render, choose "Web Service" and connect the GitHub repo
- Set the start command to:

```bash
gunicorn web_app:app
```

- Add a secret environment variable such as:

```text
SECRET_KEY=your-very-long-random-string
```

- Keep the app listening on the port provided by the host, which is usually managed automatically by the platform

### Why not Vercel first?

Vercel is excellent for frontend apps, but this project is a Python Flask application. For a beginner, Render or Railway is usually easier because it supports Python web apps more directly.

### Next step

The next best step is to:

- create a GitHub repository,
- push the project,
- then deploy it to Render or Railway.

We can do that together step by step next.
