import pytest

from web_app import create_app


@pytest.fixture()
def client():
    app = create_app(testing=True)
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def test_login_page_loads(client):
    response = client.get('/login')
    assert response.status_code == 200
    assert b'Login' in response.data


def test_admin_can_login(client):
    response = client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    assert response.status_code == 200
    assert b'Dashboard' in response.data


def test_admin_can_login_with_email(client):
    response = client.post('/login', data={'email': 'admin@sproutedgroup.com', 'password': 'admin123'}, follow_redirects=True)
    assert response.status_code == 200
    assert b'Dashboard' in response.data


def test_viewer_cannot_add_company(client):
    client.post('/login', data={'username': 'viewer', 'password': 'viewer123'}, follow_redirects=True)
    response = client.get('/companies/add', follow_redirects=True)
    assert response.status_code == 403


def test_viewer_can_view_transactions_but_not_add_them(client):
    client.post('/login', data={'username': 'viewer', 'password': 'viewer123'}, follow_redirects=True)
    response_get = client.get('/transactions')
    assert response_get.status_code == 200

    response_post = client.post('/transactions', data={
        'company_id': '1',
        'description': 'Viewer test',
        'amount': '10.00',
        'entry_type': 'income',
    }, follow_redirects=True)
    assert response_post.status_code == 403


def test_manager_can_add_transactions(client):
    client.post('/login', data={'username': 'manager', 'password': 'manager123'}, follow_redirects=True)
    response = client.post('/transactions', data={
        'company_id': '1',
        'description': 'Manager test',
        'amount': '10.00',
        'entry_type': 'income',
    }, follow_redirects=True)
    assert response.status_code == 200


def test_transactions_record_project_and_funding(client):
    client.post('/login', data={'username': 'manager', 'password': 'manager123'}, follow_redirects=True)
    response = client.post('/transactions', data={
        'company_id': '1',
        'description': 'School feeding donation',
        'amount': '2500.00',
        'entry_type': 'income',
        'project_name': 'Youth Education Programme',
        'fund_type': 'restricted',
    }, follow_redirects=True)
    assert response.status_code == 200
    assert b'Youth Education Programme' in response.data
    assert b'restricted' in response.data.lower()


def test_admin_can_add_company(client):
    client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    response = client.post('/companies/add', data={'name': 'Sprouted Horizon', 'company_type': 'LLC', 'code': 'SH'}, follow_redirects=True)
    assert response.status_code == 200
    assert b'Sprouted Horizon' in response.data


def test_admin_can_manage_user_company_access(client):
    client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    response = client.get('/users')
    assert response.status_code == 200
    assert b'Manage access' in response.data

    response = client.post('/users/1/access', data={
        'company_id': '1',
        'role': 'accountant',
        'can_view_reports': 'on',
        'can_add_transactions': 'on',
        'can_manage_users': 'off',
    }, follow_redirects=True)
    assert response.status_code == 200
    assert b'Access updated' in response.data


def test_users_page_displays_permission_summary(client):
    client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    response = client.get('/users')
    assert response.status_code == 200
    assert b'Reports' in response.data
    assert b'Transactions' in response.data
    assert b'Users' in response.data


def test_role_permission_defaults_match_business_rules():
    from web_app import get_role_permissions

    assert get_role_permissions('admin') == {
        'can_view_reports': True,
        'can_add_transactions': True,
        'can_manage_users': True,
    }
    assert get_role_permissions('accountant') == {
        'can_view_reports': True,
        'can_add_transactions': True,
        'can_manage_users': False,
    }
    assert get_role_permissions('manager') == {
        'can_view_reports': True,
        'can_add_transactions': True,
        'can_manage_users': False,
    }
    assert get_role_permissions('viewer') == {
        'can_view_reports': True,
        'can_add_transactions': False,
        'can_manage_users': False,
    }


def test_chart_of_accounts_are_seeded_by_company_type(client):
    client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    response = client.get('/accounts')
    assert response.status_code == 200
    assert b'Cash' in response.data
    assert b'General Operations' in response.data


def test_reports_show_project_breakdown(client):
    client.post('/login', data={'username': 'manager', 'password': 'manager123'}, follow_redirects=True)
    client.post('/transactions', data={
        'company_id': '1',
        'description': 'Seasonal donation',
        'amount': '500.00',
        'entry_type': 'income',
        'project_name': 'Youth Education Programme',
        'fund_type': 'restricted',
    }, follow_redirects=True)
    client.post('/transactions', data={
        'company_id': '1',
        'description': 'Learning materials',
        'amount': '120.00',
        'entry_type': 'expense',
        'project_name': 'Youth Education Programme',
        'fund_type': 'restricted',
    }, follow_redirects=True)
    response = client.get('/reports')
    assert response.status_code == 200
    assert b'Youth Education Programme' in response.data
    assert b'restricted' in response.data.lower()


def test_project_budgets_are_recorded_and_variance_visible(client):
    client.post('/login', data={'username': 'manager', 'password': 'manager123'}, follow_redirects=True)
    response = client.post('/budgets', data={
        'company_id': '1',
        'project_name': 'Youth Education Programme',
        'fund_type': 'restricted',
        'budget_amount': '1500.00',
    }, follow_redirects=True)
    assert response.status_code == 200
    assert b'Budget' in response.data
    assert b'1500.00' in response.data


def test_runtime_config_defaults_to_sqlite(monkeypatch):
    monkeypatch.delenv('SUPABASE_URL', raising=False)
    monkeypatch.delenv('SUPABASE_ANON_KEY', raising=False)
    monkeypatch.delenv('SUPABASE_SERVICE_ROLE_KEY', raising=False)
    monkeypatch.delenv('SUPABASE_SERVICE_KEY', raising=False)

    from web_app import get_runtime_config

    config = get_runtime_config()
    assert config['database_backend'] == 'sqlite'
