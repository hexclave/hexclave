# Stack Auth Python SDK

Python SDK for [Stack Auth](https://stack-auth.com) — the open-source authentication platform. Provides `StackServerApp` for server-side user management, team operations, JWT verification, and more.

## Installation

```bash
pip install stack-auth
```

## Quick Start

```python
from stack_auth import StackServerApp

app = StackServerApp(
    project_id="your-project-id",
    secret_server_key="your-secret-server-key",
)

# List users
users = app.list_users(limit=10)
for user in users.items:
    print(f"{user.display_name} ({user.primary_email})")

# Create a user
user = app.create_user(
    primary_email="user@example.com",
    password="securepassword",
    display_name="Jane Doe",
)

# Get a user
user = app.get_user("user-id")

# Update a user
updated = app.update_user("user-id", display_name="New Name")

# Delete a user
app.delete_user("user-id")
```

## Async Support

Every method has an async equivalent via `AsyncStackServerApp`:

```python
from stack_auth import AsyncStackServerApp

app = AsyncStackServerApp(
    project_id="your-project-id",
    secret_server_key="your-secret-server-key",
)

user = await app.get_user("user-id")
users = await app.list_users(limit=10)
team = await app.create_team(display_name="Engineering")
```

## Authentication

Verify incoming request tokens without framework-specific middleware:

```python
from stack_auth._auth import sync_authenticate_request
from stack_auth._jwt import SyncJWKSFetcher

fetcher = SyncJWKSFetcher(
    project_id="your-project-id",
    base_url="https://api.stack-auth.com",
)

# Works with any object that has a .headers mapping
result = sync_authenticate_request(request, fetcher=fetcher)

if result.status == "authenticated":
    print(f"User: {result.user_id}")
else:
    print("Not authenticated")
```

### FastAPI Example

```python
from fastapi import Depends, HTTPException, Request
from stack_auth._auth import sync_authenticate_request
from stack_auth._jwt import SyncJWKSFetcher

fetcher = SyncJWKSFetcher(project_id="...", base_url="https://api.stack-auth.com")

def get_user_id(request: Request) -> str:
    result = sync_authenticate_request(request, fetcher=fetcher)
    if result.status != "authenticated":
        raise HTTPException(status_code=401)
    return result.user_id

@app.get("/protected")
def protected_route(user_id: str = Depends(get_user_id)):
    return {"user_id": user_id}
```

## Error Handling

All API errors raise typed exceptions:

```python
from stack_auth.errors import (
    StackAuthError,
    AuthenticationError,
    NotFoundError,
    ValidationError,
)

try:
    user = app.get_user("invalid-id")
except NotFoundError as e:
    print(f"Not found: {e.message}")
except AuthenticationError as e:
    print(f"Auth failed: {e.code}")
except StackAuthError as e:
    print(f"API error: {e.code} - {e.message}")
```

## Teams

```python
# Create a team
team = app.create_team(
    display_name="Engineering",
    creator_user_id="user-id",
)

# List teams
teams = app.list_teams(user_id="user-id")

# Manage members
app.add_team_member(team_id=team.id, user_id="another-user-id")
profiles = app.list_team_member_profiles(team_id=team.id)

# Permissions
app.grant_team_permission(
    team_id=team.id,
    user_id="user-id",
    permission_id="admin",
)
```

## Self-Hosted

Point to your self-hosted Stack Auth instance:

```python
app = StackServerApp(
    project_id="your-project-id",
    secret_server_key="your-secret-key",
    base_url="https://your-stack-auth.example.com",
)
```

## API Reference

### StackServerApp / AsyncStackServerApp

**Constructor:**
- `project_id` (str) — Your Stack Auth project ID
- `secret_server_key` (str) — Server secret key from the dashboard
- `base_url` (str, optional) — API base URL (default: `https://api.stack-auth.com`)
- `publishable_client_key` (str, optional) — Required for projects with `requirePublishableClientKey`
- `token_store` (optional) — Token storage strategy

**User methods:** `get_user`, `list_users`, `create_user`, `update_user`, `delete_user`, `get_user_by_api_key`, `get_partial_user`

**Team methods:** `get_team`, `list_teams`, `create_team`, `update_team`, `delete_team`, `get_team_by_api_key`, `add_team_member`, `remove_team_member`, `list_team_member_profiles`, `get_team_member_profile`, `send_team_invitation`, `list_team_invitations`, `revoke_team_invitation`

**Permission methods:** `grant_team_permission`, `revoke_team_permission`, `list_team_permissions`, `grant_user_permission`, `revoke_user_permission`, `list_user_permissions`

**Session methods:** `list_sessions`, `get_session`, `revoke_session`

**Contact channel methods:** `send_contact_channel_verification`, `verify_contact_channel`, `check_contact_channel_verification`

**API key methods:** `create_user_api_key`, `list_user_api_keys`, `revoke_user_api_key`, `create_team_api_key`, `list_team_api_keys`, `revoke_team_api_key`, `check_api_key`

**OAuth methods:** `list_oauth_providers`, `create_oauth_provider`, `get_oauth_provider`, `list_connected_accounts`

**Payment methods:** `list_products`, `get_item`, `grant_product`, `cancel_subscription`

**Email methods:** `send_email`, `get_email_delivery_stats`

**Data vault:** `get_data_vault_store` → returns `DataVaultStore` with `get`, `set`, `delete`, `list_keys`

## Development

```bash
# Clone the repo
git clone https://github.com/stack-auth/stack-auth.git
cd stack-auth/sdks/implementations/python

# Install in dev mode
pip install -e ".[dev]"

# Run unit tests (no server needed)
python3 -m pytest tests/ -v

# Run E2E tests (requires running Stack Auth)
# First: pnpm start-deps && pnpm dev (from monorepo root)
STACK_E2E=1 python3 -m pytest tests/test_e2e.py -v -s
```

## Requirements

- Python >= 3.10
- httpx
- PyJWT[crypto]
- pydantic >= 2.7

## License

MIT — same as [Stack Auth](https://github.com/stack-auth/stack-auth).
