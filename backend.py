import os
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, request

try:
    from dotenv import load_dotenv
    # Load standard .env if present, then also support your stored path.
    load_dotenv()
    load_dotenv(Path(__file__).with_name(".env"))
    load_dotenv(Path(__file__).with_name(".gitignore") / ".env")
except Exception:
    # Running without python-dotenv is fine if env vars are set externally.
    pass


def _clean_env(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip("<>").strip()


app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
