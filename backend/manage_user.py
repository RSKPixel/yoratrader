"""Create the login user, or reset a forgotten password.

Usage (from the repo root):
    backend/venv/bin/python backend/manage_user.py
"""

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import auth  # noqa: E402


def main():
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
