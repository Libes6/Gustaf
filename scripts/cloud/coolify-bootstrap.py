import json
import os
import urllib.error
import urllib.request

base = os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1/'
token = os.environ['COOLIFY_TOKEN']


def api(path, method='GET', data=None):
    request = urllib.request.Request(
        base + path,
        data=None if data is None else json.dumps(data).encode(),
        method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Coolify {method} {path}: HTTP {error.code}; response body omitted to protect credentials') from None


def one(rows, name):
    matches = [row for row in rows if row.get('name', '').lower() == name.lower()]
    if len(matches) != 1:
        raise SystemExit(f'Expected exactly one resource named {name}, got {len(matches)}')
    return matches[0]


project = one(api('projects'), 'Gustaf')
database = one(api('databases'), 'gustaf-postgres')
database = api('databases/' + database['uuid'])
environment = api(f"projects/{project['uuid']}/production")
if database['environment_id'] != environment['id']:
    raise SystemExit('Database is outside the selected project environment')
if not database.get('status', '').startswith('running'):
    raise SystemExit('PostgreSQL is not running')
destination = database['destination']
server = destination['server']
database_url = os.environ.get('BOOTSTRAP_DATABASE_URL') or database.get('internal_db_url')
if not database_url or '***' in database_url:
    raise SystemExit('Internal database URL unavailable: set the temporary BOOTSTRAP_DATABASE_URL secret')
print('::add-mask::' + database_url)
password = database.get('postgres_password')
if password:
    print('::add-mask::' + password)
image = os.environ['IMAGE']
tag = os.environ['TAG']
apps = [row for row in api('applications') if row.get('name') == 'gustaf-cloud-api']
if len(apps) > 1:
    raise SystemExit('Multiple gustaf-cloud-api applications exist; refusing to choose')
if apps:
    app = api('applications/' + apps[0]['uuid'])
    if app.get('environment_id') != environment['id']:
        raise SystemExit('Existing API belongs to another environment')
else:
    app = api('applications/dockerimage', 'POST', {
        'project_uuid': project['uuid'], 'environment_uuid': environment['uuid'],
        'server_uuid': server['uuid'], 'destination_uuid': destination['uuid'],
        'name': 'gustaf-cloud-api', 'docker_registry_image_name': image,
        'docker_registry_image_tag': tag, 'ports_exposes': '3100',
        'domains': 'https://api.libes6.ru', 'instant_deploy': False,
        'health_check_enabled': True, 'health_check_path': '/health/ready',
        'health_check_port': '3100', 'health_check_method': 'GET',
        'health_check_return_code': 200,
    })
uuid = app['uuid']
api('applications/' + uuid, 'PATCH', {
    'docker_registry_image_name': image, 'docker_registry_image_tag': tag,
})
api('applications/' + uuid + '/envs/bulk', 'PATCH', {'data': [
    {'key': 'DATABASE_URL', 'value': database_url, 'is_literal': True, 'is_shown_once': True},
    {'key': 'HOST', 'value': '0.0.0.0', 'is_literal': True},
    {'key': 'PORT', 'value': '3100', 'is_literal': True},
]})
api('deploy', 'POST', {'uuid': uuid, 'force': False})
print('API_UUID=' + uuid)
print('IMAGE=' + image + ':' + tag)
print('Deployment request accepted; verify completion and HTTPS readiness.')
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    summary.write(f'API UUID: `{uuid}`\n\nImage: `{image}:{tag}`\n\nURL: https://api.libes6.ru/health/ready\n')
