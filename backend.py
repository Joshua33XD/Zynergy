wimport os
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, request

try:
    from dotenv import load_dotenv

    load_dotenv()
    load_dotenv(Path(__file__).with_name(".env"))
    load_dotenv(Path(__file__).with_name(".gitignore") / ".env")
except Exception:
    pass


LOGMEAL_API_BASE = os.getenv("LOGMEAL_API_BASE", "https://api.logmeal.com").rstrip("/")
LOGMEAL_SEGMENTATION_PATH = os.getenv(
    "LOGMEAL_SEGMENTATION_PATH",
    "/v2/image/segmentation/complete",
)
OPENFOODFACTS_API_BASE = os.getenv(
    "OPENFOODFACTS_API_BASE",
    "https://world.openfoodfacts.org",
).rstrip("/")
API_NINJAS_API_BASE = os.getenv(
    "API_NINJAS_API_BASE",
    "https://api.api-ninjas.com",
).rstrip("/")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("FOOD_API_TIMEOUT", "30"))


def _clean_env(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip("<>").strip()


def _first_present(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _extract_float(*values: Any) -> float | None:
    for value in values:
        if value is None or value == "":
            continue
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                continue
    return None


def _normalize_label(label: str | None) -> str:
    if not label:
        return ""
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in label)
    return " ".join(cleaned.split())


def _build_logmeal_auth_header() -> dict[str, str]:
    token = _clean_env(os.getenv("LOGMEAL_API_TOKEN") or os.getenv("LOGMEAL_TOKEN"))
    if not token:
        raise ValueError("Missing LOGMEAL_API_TOKEN (or LOGMEAL_TOKEN) environment variable.")
    if token.lower().startswith("bearer "):
        return {"Authorization": token}
    return {"Authorization": f"Bearer {token}"}


def _scale_nutrition(per_100g: dict[str, float] | None, grams: float) -> dict[str, float] | None:
    if not per_100g:
        return None
    factor = max(0.0, grams) / 100.0
    return {
        key: round(value * factor, 2)
        for key, value in per_100g.items()
        if isinstance(value, (int, float))
    }


def _sum_totals(items: list[dict[str, Any]]) -> dict[str, float]:
    totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
    for item in items:
        nutrition = item.get("nutrition") or {}
        for key in totals:
            value = nutrition.get(key)
            if isinstance(value, (int, float)):
                totals[key] += float(value)
    return {key: round(value, 2) for key, value in totals.items()}


def _extract_bbox(item: dict[str, Any]) -> dict[str, float] | None:
    if not isinstance(item, dict):
        return None
    bbox = item.get("bbox") or item.get("box") or item.get("bounding_box")
    if isinstance(bbox, dict):
        x = _extract_float(bbox.get("x"), bbox.get("left"), bbox.get("x1"))
        y = _extract_float(bbox.get("y"), bbox.get("top"), bbox.get("y1"))
        width = _extract_float(bbox.get("width"), bbox.get("w"))
        height = _extract_float(bbox.get("height"), bbox.get("h"))
        x2 = _extract_float(bbox.get("x2"))
        y2 = _extract_float(bbox.get("y2"))
        if width is None and x is not None and x2 is not None:
            width = max(0.0, x2 - x)
        if height is None and y is not None and y2 is not None:
            height = max(0.0, y2 - y)
        if x is not None and y is not None and width is not None and height is not None:
            return {
                "x": round(x, 3),
                "y": round(y, 3),
                "width": round(width, 3),
                "height": round(height, 3),
            }

    x = _extract_float(item.get("x"), item.get("left"), item.get("x1"))
    y = _extract_float(item.get("y"), item.get("top"), item.get("y1"))
    width = _extract_float(item.get("width"), item.get("w"))
    height = _extract_float(item.get("height"), item.get("h"))
    x2 = _extract_float(item.get("x2"))
    y2 = _extract_float(item.get("y2"))
    if width is None and x is not None and x2 is not None:
        width = max(0.0, x2 - x)
    if height is None and y is not None and y2 is not None:
        height = max(0.0, y2 - y)
    if x is not None and y is not None and width is not None and height is not None:
        return {
            "x": round(x, 3),
            "y": round(y, 3),
            "width": round(width, 3),
            "height": round(height, 3),
        }
    return None


def _extract_serving_grams(item: dict[str, Any]) -> float:
    serving = item.get("serving_size")
    grams = None
    if isinstance(serving, dict):
        grams = _extract_float(
            serving.get("grams"),
            serving.get("g"),
            serving.get("value"),
            serving.get("amount"),
        )
    else:
        grams = _extract_float(serving)
    grams = _first_present(
        grams,
        _extract_float(item.get("weight_g"), item.get("grams"), item.get("quantity_g")),
        150.0,
    )
    grams = float(grams)
    return round(min(max(grams, 30.0), 600.0), 0)


def _extract_candidates(item: dict[str, Any]) -> list[dict[str, Any]]:
    candidate_keys = (
        "recognition_results",
        "recognitionResults",
        "results",
        "predictions",
        "candidates",
        "foods",
    )
    raw_candidates = None
    for key in candidate_keys:
        value = item.get(key)
        if isinstance(value, list) and value:
            raw_candidates = value
            break

    if raw_candidates is None:
        direct_name = _first_present(
            item.get("name"),
            item.get("label"),
            item.get("foodName"),
            item.get("dish"),
            item.get("dish_name"),
        )
        if direct_name:
            raw_candidates = [item]

    candidates: list[dict[str, Any]] = []
    for candidate in raw_candidates or []:
        if not isinstance(candidate, dict):
            continue
        label = _first_present(
            candidate.get("name"),
            candidate.get("label"),
            candidate.get("foodName"),
            candidate.get("dish"),
            candidate.get("dish_name"),
            candidate.get("food"),
        )
        if not label:
            continue
        confidence = _extract_float(
            candidate.get("prob"),
            candidate.get("confidence"),
            candidate.get("score"),
            candidate.get("probability"),
        )
        candidates.append(
            {
                "label": str(label).strip(),
                "confidence": round(confidence, 4) if confidence is not None else None,
            }
        )
    return candidates


def _parse_logmeal_response(payload: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    image_id = _first_present(payload.get("imageId"), payload.get("image_id"))
    regions = payload.get("segmentation_results")
    detections: list[dict[str, Any]] = []

    if isinstance(regions, list):
        for index, region in enumerate(regions, start=1):
            if not isinstance(region, dict):
                continue
            candidates = _extract_candidates(region)
            if not candidates:
                continue
            chosen = candidates[0]
            detections.append(
                {
                    "id": f"detected-{index}",
                    "label": chosen["label"],
                    "confidence": chosen.get("confidence"),
                    "grams": _extract_serving_grams(region),
                    "default_grams": _extract_serving_grams(region),
                    "bbox": _extract_bbox(region),
                    "candidates": candidates[:5],
                }
            )

    if detections:
        return str(image_id) if image_id is not None else None, detections

    top_level_candidates = _extract_candidates(payload)
    if top_level_candidates:
        chosen = top_level_candidates[0]
        return (
            str(image_id) if image_id is not None else None,
            [
                {
                    "id": "detected-1",
                    "label": chosen["label"],
                    "confidence": chosen.get("confidence"),
                    "grams": 150.0,
                    "default_grams": 150.0,
                    "bbox": None,
                    "candidates": top_level_candidates[:5],
                }
            ],
        )

    raise ValueError("LogMeal returned no recognizable foods for this image.")


def _fetch_logmeal_detections(
    image_bytes: bytes,
    filename: str,
    content_type: str,
) -> tuple[str | None, list[dict[str, Any]]]:
    headers = _build_logmeal_auth_header()
    response = requests.post(
        f"{LOGMEAL_API_BASE}{LOGMEAL_SEGMENTATION_PATH}",
        headers=headers,
        files={"image": (filename, image_bytes, content_type)},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text}

    if not response.ok:
        detail = _first_present(payload.get("message"), payload.get("detail"), response.text)
        raise RuntimeError(f"LogMeal request failed ({response.status_code}): {detail}")

    if not isinstance(payload, dict):
        raise ValueError("LogMeal returned an unexpected response format.")
    return _parse_logmeal_response(payload)


def _parse_api_ninjas_item(item: dict[str, Any]) -> dict[str, float] | None:
    if not isinstance(item, dict):
        return None
    calories = _extract_float(item.get("calories"))
    protein_g = _extract_float(item.get("protein_g"))
    carbs_g = _extract_float(item.get("carbohydrates_total_g"))
    fat_g = _extract_float(item.get("fat_total_g"))
    if calories is None and protein_g is None and carbs_g is None and fat_g is None:
        return None
    return {
        "calories": round(calories or 0.0, 2),
        "protein_g": round(protein_g or 0.0, 2),
        "carbs_g": round(carbs_g or 0.0, 2),
        "fat_g": round(fat_g or 0.0, 2),
    }


def _fetch_api_ninjas_nutrition(food_name: str) -> dict[str, Any] | None:
    api_key = _clean_env(os.getenv("API_NINJAS_API_KEY"))
    if not api_key:
        return None

    headers = {"X-Api-Key": api_key}
    attempts = [
        ("/v1/nutritionitem", {"query": food_name, "quantity": "100g"}),
        ("/v1/nutrition", {"query": f"100g {food_name}"}),
    ]

    for path, params in attempts:
        response = requests.get(
            f"{API_NINJAS_API_BASE}{path}",
            headers=headers,
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if not response.ok:
            continue
        try:
            payload = response.json()
        except ValueError:
            continue
        if not isinstance(payload, list) or not payload:
            continue
        parsed = _parse_api_ninjas_item(payload[0])
        if parsed:
            return {"source": "api_ninjas", "nutrition_per_100g": parsed}
    return None


def _openfoodfacts_score(product_name: str, query: str, nutrient_count: int) -> tuple[int, int, int]:
    product_norm = _normalize_label(product_name)
    query_norm = _normalize_label(query)
    if not product_norm:
        return (0, 0, nutrient_count)
    query_tokens = set(query_norm.split())
    product_tokens = set(product_norm.split())
    shared = len(query_tokens & product_tokens)
    exact = 1 if product_norm == query_norm else 0
    starts = 1 if product_norm.startswith(query_norm) else 0
    return (exact + starts, shared, nutrient_count)


def _fetch_openfoodfacts_nutrition(food_name: str) -> dict[str, Any] | None:
    fields = "product_name,brands,nutriments,image_front_small_url"
    response = requests.get(
        f"{OPENFOODFACTS_API_BASE}/cgi/search.pl",
        params={
            "action": "process",
            "search_terms": food_name,
            "json": 1,
            "page_size": 5,
            "fields": fields,
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    if not response.ok:
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    products = payload.get("products")
    if not isinstance(products, list):
        return None

    best_match = None
    best_score = (-1, -1, -1)
    for product in products:
        if not isinstance(product, dict):
            continue
        nutriments = product.get("nutriments") or {}
        parsed = {
            "calories": _extract_float(
                nutriments.get("energy-kcal_100g"),
                nutriments.get("energy-kcal_value"),
            ),
            "protein_g": _extract_float(nutriments.get("proteins_100g")),
            "carbs_g": _extract_float(nutriments.get("carbohydrates_100g")),
            "fat_g": _extract_float(nutriments.get("fat_100g")),
        }
        nutrient_count = sum(
            1 for value in parsed.values() if isinstance(value, (int, float))
        )
        if nutrient_count == 0:
            continue
        product_name = str(product.get("product_name") or "").strip()
        score = _openfoodfacts_score(product_name, food_name, nutrient_count)
        if score > best_score:
            best_score = score
            best_match = {
                "source": "open_food_facts",
                "nutrition_per_100g": {
                    key: round(float(value or 0.0), 2)
                    for key, value in parsed.items()
                },
                "matched_name": product_name or food_name,
                "image_url": product.get("image_front_small_url"),
                "brand": product.get("brands"),
            }

    return best_match


def _resolve_nutrition(food_name: str) -> tuple[dict[str, float] | None, str | None, dict[str, Any] | None]:
    api_ninjas_match = _fetch_api_ninjas_nutrition(food_name)
    if api_ninjas_match:
        return (
            api_ninjas_match["nutrition_per_100g"],
            api_ninjas_match["source"],
            api_ninjas_match,
        )

    openfoodfacts_match = _fetch_openfoodfacts_nutrition(food_name)
    if openfoodfacts_match:
        return (
            openfoodfacts_match["nutrition_per_100g"],
            openfoodfacts_match["source"],
            openfoodfacts_match,
        )

    return None, None, None


def _enrich_detections(detections: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    enriched: list[dict[str, Any]] = []
    warnings: list[str] = []

    for detection in detections:
        per_100g, nutrition_source, nutrition_meta = _resolve_nutrition(detection["label"])
        if per_100g is None:
            warnings.append(f"No fallback nutrition found for {detection['label']}.")
        enriched.append(
            {
                **detection,
                "nutrition_per_100g": per_100g,
                "nutrition": _scale_nutrition(per_100g, float(detection["grams"])),
                "nutrition_source": nutrition_source,
                "nutrition_meta": nutrition_meta,
            }
        )

    return enriched, warnings


app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.get("/api/health")
def healthcheck():
    return jsonify(
        {
            "ok": True,
            "services": {
                "logmeal_configured": bool(
                    _clean_env(os.getenv("LOGMEAL_API_TOKEN") or os.getenv("LOGMEAL_TOKEN"))
                ),
                "api_ninjas_configured": bool(_clean_env(os.getenv("API_NINJAS_API_KEY"))),
            },
        }
    )


@app.route("/api/food/analyze", methods=["POST", "OPTIONS"])
def analyze_food():
    if request.method == "OPTIONS":
        return ("", 204)

    image = request.files.get("image")
    if image is None or not image.filename:
        return jsonify({"ok": False, "error": "Please upload an image file."}), 400

    image_bytes = image.read()
    if not image_bytes:
        return jsonify({"ok": False, "error": "Uploaded image was empty."}), 400

    try:
        image_id, detections = _fetch_logmeal_detections(
            image_bytes=image_bytes,
            filename=image.filename,
            content_type=image.mimetype or "application/octet-stream",
        )
        enriched, warnings = _enrich_detections(detections)
    except ValueError as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": f"Upstream request failed: {error}"}), 502
    except RuntimeError as error:
        return jsonify({"ok": False, "error": str(error)}), 502
    except Exception as error:
        return jsonify({"ok": False, "error": f"Unexpected analysis failure: {error}"}), 500

    return jsonify(
        {
            "ok": True,
            "image_id": image_id,
            "detections": enriched,
            "totals": _sum_totals(enriched),
            "warnings": warnings,
            "services": {
                "logmeal": True,
                "api_ninjas_used": any(
                    item.get("nutrition_source") == "api_ninjas" for item in enriched
                ),
                "open_food_facts_used": any(
                    item.get("nutrition_source") == "open_food_facts" for item in enriched
                ),
            },
        }
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
