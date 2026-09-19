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


def test_viewer_cannot_add_company(client):
    client.post('/login', data={'username': 'viewer', 'password': 'viewer123'}, follow_redirects=True)
    response = client.get('/companies/add', follow_redirects=True)
    assert response.status_code == 403


def test_admin_can_add_company(client):
    client.post('/login', data={'username': 'admin', 'password': 'admin123'}, follow_redirects=True)
    response = client.post('/companies/add', data={'name': 'Sprouted Digital', 'company_type': 'llc', 'code': 'SD'}, follow_redirects=True)
    assert response.status_code == 200
    assert b'Sprouted Digital' in response.data
