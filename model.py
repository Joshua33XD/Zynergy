from __future__ import annotations

import argparse
import difflib
import json
import os
import random
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd
import yaml
from PIL import Image
from ultralytics import YOLO


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = "yolov8n.pt"
DEFAULT_DATASET_CSV = BASE_DIR / "fooddata" / "Indian_Food_Nutrition_Processed.csv"
DEFAULT_UECFOOD_DIR = BASE_DIR / "uecfood" / "UECFOOD256"
DEFAULT_UEC_YOLO_DIR = BASE_DIR / "uecfood_yolo_prepared"
DEFAULT_DATA_YAML = DEFAULT_UEC_YOLO_DIR / "uecfood256.yaml"
DEFAULT_RUNS_DIR = BASE_DIR / "runs"
DEFAULT_TRAIN_RUN_NAME = "uecfood_yolo"

NUTRITION_COLUMNS = [
    "Calories (kcal)",
    "Carbohydrates (g)",
    "Protein (g)",
    "Fats (g)",
    "Free Sugar (g)",
    "Fibre (g)",
    "Sodium (mg)",
    "Calcium (mg)",
    "Iron (mg)",
    "Vitamin C (mg)",
    "Folate (µg)",
]


def load_uec_categories(uec_dir: str | Path = DEFAULT_UECFOOD_DIR) -> list[tuple[int, str]]:
    uec_dir = Path(uec_dir)
    category_file = uec_dir / "category.txt"
    if not category_file.exists():
        raise FileNotFoundError(f"UEC category file not found: {category_file}")

    categories = pd.read_csv(category_file, sep="\t")
    required = {"id", "name"}
    missing = required.difference(categories.columns)
    if missing:
        raise ValueError(f"Missing required UEC category columns: {sorted(missing)}")

    return [
        (int(row["id"]), str(row["name"]).strip())
        for _, row in categories.sort_values("id").iterrows()
    ]


def _convert_bbox_to_yolo(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float]:
    x1 = min(max(x1, 0.0), float(image_width))
    x2 = min(max(x2, 0.0), float(image_width))
    y1 = min(max(y1, 0.0), float(image_height))
    y2 = min(max(y2, 0.0), float(image_height))

    box_width = max(x2 - x1, 0.0)
    box_height = max(y2 - y1, 0.0)
    center_x = x1 + (box_width / 2.0)
    center_y = y1 + (box_height / 2.0)

    return (
        center_x / image_width,
        center_y / image_height,
        box_width / image_width,
        box_height / image_height,
    )


def prepare_uecfood_yolo_dataset(
    uec_dir: str | Path = DEFAULT_UECFOOD_DIR,
    output_dir: str | Path = DEFAULT_UEC_YOLO_DIR,
    train_split: float = 0.8,
    val_split: float = 0.1,
    seed: int = 42,
) -> dict[str, Any]:
    if train_split <= 0 or val_split <= 0 or train_split + val_split >= 1:
        raise ValueError("train_split and val_split must be positive, and leave room for a test split.")

    uec_dir = Path(uec_dir)
    output_dir = Path(output_dir)
    if not uec_dir.exists():
        raise FileNotFoundError(f"UEC dataset directory not found: {uec_dir}")

    categories = load_uec_categories(uec_dir)
    category_index = {category_id: idx for idx, (category_id, _) in enumerate(categories)}
    grouped_samples: dict[tuple[int, str], dict[str, Any]] = {}
    annotation_count = 0

    for category_id, category_name in categories:
        category_dir = uec_dir / str(category_id)
        bbox_file = category_dir / "bb_info.txt"
        if not category_dir.exists() or not bbox_file.exists():
            continue

        lines = bbox_file.read_text(encoding="utf-8").splitlines()
        for raw_line in lines[1:]:
            line = raw_line.strip()
            if not line:
                continue

            parts = line.split()
            if len(parts) != 5:
                continue

            image_id, x1, y1, x2, y2 = parts
            image_path = category_dir / f"{image_id}.jpg"
            if not image_path.exists():
                continue

            key = (category_id, image_id)
            sample = grouped_samples.setdefault(
                key,
                {
                    "category_id": category_id,
                    "category_name": category_name,
                    "class_index": category_index[category_id],
                    "image_id": image_id,
                    "image_path": image_path,
                    "bboxes": [],
                },
            )
            sample["bboxes"].append(tuple(float(value) for value in (x1, y1, x2, y2)))
            annotation_count += 1

    samples = list(grouped_samples.values())
    if not samples:
        raise ValueError(f"No annotated UEC samples found in: {uec_dir}")

    rng = random.Random(seed)
    rng.shuffle(samples)

    total = len(samples)
    train_count = int(total * train_split)
    val_count = int(total * val_split)
    splits = {
        "train": samples[:train_count],
        "val": samples[train_count : train_count + val_count],
        "test": samples[train_count + val_count :],
    }

    for split_name in splits:
        (output_dir / "images" / split_name).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split_name).mkdir(parents=True, exist_ok=True)

    for split_name, split_samples in splits.items():
        for sample in split_samples:
            source_image = sample["image_path"]
            target_stem = f"{sample['category_id']:03d}_{sample['image_id']}"
            target_image = output_dir / "images" / split_name / f"{target_stem}.jpg"
            target_label = output_dir / "labels" / split_name / f"{target_stem}.txt"

            if not target_image.exists():
                try:
                    os.link(source_image, target_image)
                except OSError:
                    shutil.copy2(source_image, target_image)
            with Image.open(source_image) as image:
                width, height = image.size

            label_lines: list[str] = []
            for bbox in sample["bboxes"]:
                center_x, center_y, box_width, box_height = _convert_bbox_to_yolo(
                    *bbox, image_width=width, image_height=height
                )
                label_lines.append(
                    f"{sample['class_index']} "
                    f"{center_x:.6f} {center_y:.6f} {box_width:.6f} {box_height:.6f}"
                )
            target_label.write_text("\n".join(label_lines) + "\n", encoding="utf-8")

    yaml_path = output_dir / "uecfood256.yaml"
    yaml_data = {
        "path": str(output_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {idx: name for idx, (_, name) in enumerate(categories)},
    }
    yaml_path.write_text(yaml.safe_dump(yaml_data, sort_keys=False), encoding="utf-8")

    return {
        "yaml_path": yaml_path,
        "output_dir": output_dir,
        "class_count": len(categories),
        "image_count": total,
        "annotation_count": annotation_count,
        "split_counts": {name: len(items) for name, items in splits.items()},
    }


def normalize_name(value: str) -> str:
    text = value.strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def extract_name_variants(food_name: str) -> set[str]:
    variants = {normalize_name(food_name)}
    if "(" in food_name and ")" in food_name:
        base = food_name.split("(", 1)[0].strip()
        inside = food_name.split("(", 1)[1].rsplit(")", 1)[0].strip()
        if base:
            variants.add(normalize_name(base))
        if inside:
            variants.add(normalize_name(inside))
    return {item for item in variants if item}


def load_nutrition_dataset(csv_path: str | Path = DEFAULT_DATASET_CSV) -> pd.DataFrame:
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(f"Nutrition dataset not found: {csv_path}")

    df = pd.read_csv(csv_path, encoding="utf-8")
    # Some CSV exports encode micro symbol oddly. This keeps downstream keys stable.
    df.columns = [column.replace("Âµ", "µ").strip() for column in df.columns]

    required = {"Dish Name", *NUTRITION_COLUMNS}
    missing = required.difference(df.columns)
    if missing:
        raise ValueError(f"Missing required nutrition columns: {sorted(missing)}")

    for column in NUTRITION_COLUMNS:
        df[column] = pd.to_numeric(df[column], errors="coerce").fillna(0.0)

    df["normalized_name"] = df["Dish Name"].astype(str).map(normalize_name)
    return df


def build_food_lookup(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for _, row in df.iterrows():
        record = row.to_dict()
        for variant in extract_name_variants(str(row["Dish Name"])):
            lookup[variant] = record
    return lookup


def find_best_food_match(label: str, lookup: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    normalized = normalize_name(label)
    if normalized in lookup:
        return lookup[normalized]

    matches = difflib.get_close_matches(normalized, lookup.keys(), n=1, cutoff=0.6)
    if matches:
        return lookup[matches[0]]
    return None


def create_yolo_dataset_yaml(
    dataset_dir: str | Path,
    csv_path: str | Path = DEFAULT_DATASET_CSV,
    output_yaml: str | Path = DEFAULT_DATA_YAML,
) -> Path:
    dataset_dir = Path(dataset_dir)
    output_yaml = Path(output_yaml)
    df = load_nutrition_dataset(csv_path)

    class_names = sorted(df["Dish Name"].astype(str).unique().tolist())
    data = {
        "path": str(dataset_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {idx: name for idx, name in enumerate(class_names)},
    }

    output_yaml.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return output_yaml


def train_food_detector(
    dataset_yaml: str | Path = DEFAULT_DATA_YAML,
    pretrained_weights: str = DEFAULT_WEIGHTS,
    epochs: int = 50,
    imgsz: int = 640,
    project: str | Path = DEFAULT_RUNS_DIR,
    name: str = DEFAULT_TRAIN_RUN_NAME,
) -> Any:
    dataset_yaml = Path(dataset_yaml)
    if not dataset_yaml.exists():
        raise FileNotFoundError(
            f"YOLO dataset config not found: {dataset_yaml}. "
            "Create one with create_yolo_dataset_yaml() after preparing labeled images."
        )

    model = YOLO(pretrained_weights)
    return model.train(
        data=str(dataset_yaml),
        epochs=epochs,
        imgsz=imgsz,
        project=str(project),
        name=name,
    )


def detect_food(
    image_path: str | Path,
    model_path: str = DEFAULT_WEIGHTS,
    conf: float = 0.25,
) -> list[dict[str, Any]]:
    image_path = Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    model = YOLO(model_path)
    results = model.predict(source=str(image_path), conf=conf, verbose=False)
    detections: list[dict[str, Any]] = []

    for result in results:
        names = result.names
        for box in result.boxes:
            class_id = int(box.cls[0].item())
            x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
            detections.append(
                {
                    "label": names[class_id],
                    "confidence": round(float(box.conf[0].item()), 4),
                    "bbox": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                }
            )
    return detections


def summarize_nutrition(records: list[dict[str, Any]]) -> dict[str, float]:
    totals = {column: 0.0 for column in NUTRITION_COLUMNS}
    for record in records:
        for column in NUTRITION_COLUMNS:
            totals[column] += float(record.get(column, 0.0))
    return {key: round(value, 2) for key, value in totals.items()}


def analyze_food_image(
    image_path: str | Path,
    model_path: str = DEFAULT_WEIGHTS,
    csv_path: str | Path = DEFAULT_DATASET_CSV,
    conf: float = 0.25,
) -> dict[str, Any]:
    nutrition_df = load_nutrition_dataset(csv_path)
    lookup = build_food_lookup(nutrition_df)
    detections = detect_food(image_path=image_path, model_path=model_path, conf=conf)

    matched_items: list[dict[str, Any]] = []
    unmatched_items: list[dict[str, Any]] = []

    for detection in detections:
        match = find_best_food_match(detection["label"], lookup)
        if match is None:
            unmatched_items.append(detection)
            continue

        nutrition = {column: round(float(match[column]), 2) for column in NUTRITION_COLUMNS}
        matched_items.append(
            {
                "detected_label": detection["label"],
                "matched_food": match["Dish Name"],
                "confidence": detection["confidence"],
                "bbox": detection["bbox"],
                "nutrition": nutrition,
            }
        )

    totals = summarize_nutrition([item["nutrition"] for item in matched_items])
    counts = Counter(item["matched_food"] for item in matched_items)

    return {
        "image": str(Path(image_path).resolve()),
        "model": model_path,
        "detections": detections,
        "matched_items": matched_items,
        "unmatched_items": unmatched_items,
        "detected_food_counts": dict(counts),
        "total_estimated_nutrition": totals,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Train a YOLO food detector on the local UEC FOOD 256 dataset and estimate "
            "nutrition by mapping detected labels to the local FoodData CSV."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    make_yaml_parser = subparsers.add_parser("make-yaml", help="Create a YOLO dataset YAML file.")
    make_yaml_parser.add_argument("--dataset-dir", required=True, help="Root folder of the labeled image dataset.")
    make_yaml_parser.add_argument("--csv", default=str(DEFAULT_DATASET_CSV), help="Nutrition CSV path.")
    make_yaml_parser.add_argument("--out", default=str(DEFAULT_DATA_YAML), help="Output YAML path.")

    prepare_uec_parser = subparsers.add_parser(
        "prepare-uec",
        help="Convert the local UEC FOOD 256 dataset into YOLO image/label folders plus a YAML config.",
    )
    prepare_uec_parser.add_argument("--uec-dir", default=str(DEFAULT_UECFOOD_DIR), help="UEC FOOD 256 root path.")
    prepare_uec_parser.add_argument("--out-dir", default=str(DEFAULT_UEC_YOLO_DIR), help="Prepared YOLO output dir.")
    prepare_uec_parser.add_argument("--train-split", type=float, default=0.8, help="Training split ratio.")
    prepare_uec_parser.add_argument("--val-split", type=float, default=0.1, help="Validation split ratio.")
    prepare_uec_parser.add_argument("--seed", type=int, default=42, help="Random seed for dataset splitting.")

    train_parser = subparsers.add_parser("train", help="Train a YOLO model on a labeled food image dataset.")
    train_parser.add_argument(
        "--data",
        default=str(DEFAULT_DATA_YAML),
        help="YOLO dataset YAML path. Defaults to the prepared UEC FOOD 256 YAML.",
    )
    train_parser.add_argument("--weights", default=DEFAULT_WEIGHTS, help="Starting YOLO weights.")
    train_parser.add_argument("--epochs", type=int, default=50, help="Training epochs.")
    train_parser.add_argument("--imgsz", type=int, default=640, help="Training image size.")
    train_parser.add_argument("--project", default=str(DEFAULT_RUNS_DIR), help="Training output directory.")
    train_parser.add_argument("--name", default=DEFAULT_TRAIN_RUN_NAME, help="Run name.")

    detect_parser = subparsers.add_parser("detect", help="Run YOLO detection on one image.")
    detect_parser.add_argument("--image", required=True, help="Image path.")
    detect_parser.add_argument("--model", default=DEFAULT_WEIGHTS, help="YOLO model or weights path.")
    detect_parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold.")

    analyze_parser = subparsers.add_parser(
        "analyze",
        help="Detect food in an image and attach nutrition values from the CSV.",
    )
    analyze_parser.add_argument("--image", required=True, help="Image path.")
    analyze_parser.add_argument("--model", default=DEFAULT_WEIGHTS, help="YOLO model or weights path.")
    analyze_parser.add_argument("--csv", default=str(DEFAULT_DATASET_CSV), help="Nutrition CSV path.")
    analyze_parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold.")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "make-yaml":
        yaml_path = create_yolo_dataset_yaml(args.dataset_dir, args.csv, args.out)
        print(f"Created YOLO dataset config: {yaml_path}")
        print("Note: the CSV provides class names and nutrition values, but you still need labeled images.")
        return

    if args.command == "prepare-uec":
        summary = prepare_uecfood_yolo_dataset(
            uec_dir=args.uec_dir,
            output_dir=args.out_dir,
            train_split=args.train_split,
            val_split=args.val_split,
            seed=args.seed,
        )
        print(json.dumps(summary, indent=2, default=str))
        return

    if args.command == "train":
        results = train_food_detector(
            dataset_yaml=args.data,
            pretrained_weights=args.weights,
            epochs=args.epochs,
            imgsz=args.imgsz,
            project=args.project,
            name=args.name,
        )
        print(results)
        return

    if args.command == "detect":
        detections = detect_food(args.image, args.model, args.conf)
        print(json.dumps(detections, indent=2))
        return

    if args.command == "analyze":
        analysis = analyze_food_image(args.image, args.model, args.csv, args.conf)
        print(json.dumps(analysis, indent=2))
        return


if __name__ == "__main__":
    main()
