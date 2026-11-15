"""Create the login user, or reset a forgotten password.

Usage (from the repo root):
    backend/venv/bin/python backend/manage_user.py              # create a user / reset a password
    backend/venv/bin/python backend/manage_user.py --reset-2fa  # lost phone: enrol a new authenticator at next sign-in

In Docker: docker compose exec backend python manage_user.py [--reset-2fa]
"""

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import auth  # noqa: E402


def main():
    if "--reset-2fa" in sys.argv:
        username = input("User ID: ").strip()
        try:
            auth.reset_totp(username)
        except ValueError as exc:
            sys.exit(str(exc))
        print(f"Authenticator reset for '{username}'. The next sign-in shows a new QR code; existing sessions were signed out.")
        return
    print(f"Existing users: {auth.user_count()}")
    username = input("User ID: ").strip()
    password = getpass.getpass("New password: ")
    if password != getpass.getpass("Repeat password: "):
        sys.exit("Passwords don't match.")
    try:
        auth.set_user(username, password)
    except ValueError as exc:
        sys.exit(str(exc))
    print(f"Saved user '{username}'. Existing sessions for this user were signed out.")


if __name__ == "__main__":
    main()
