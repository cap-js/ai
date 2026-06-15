#!/usr/bin/env python3
"""
SAP RPT-1 OSS local inference server.

Reads JSON requests from stdin (one per line), runs predictions using the
locally cached model checkpoint, and writes JSON responses to stdout.

Protocol:
  stdin  line: {"id": <int>, "data": { ...same payload as predictRowColumns... }}
  stdout line: {"id": <int>, "result": { "predictions": [...] }}
              {"id": <int>, "error": "<message>"}

On startup, sends {"id": 0, "result": "ready"} once the model is loaded.
"""
import json
import sys
import os
import warnings
import traceback
import pandas as pd
from pathlib import Path

# Silence noisy sap_rpt_oss dtype warnings — we normalise dtypes ourselves below
warnings.filterwarnings('ignore')

# Redirect any stray prints that sap_rpt_oss writes directly to stdout so they
# don't corrupt the JSON stdout protocol
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# ─── Model loading ────────────────────────────────────────────────────────────

def load_model(model_path: str):
    """Load the SAP RPT-1 OSS classifier using pre-downloaded cache."""
    try:
        from sap_rpt_oss import SAP_RPT_OSS_Classifier
    except ImportError:
        _fatal(
            "sap_rpt_oss package not found.\n"
            "Install it with: pip install git+https://github.com/SAP-samples/sap-rpt-1-oss"
        )

    # All model files are pre-downloaded by Node.js into HF_HOME.
    # Tell huggingface_hub to use only the local cache — no network calls.
    os.environ.setdefault('HF_HUB_OFFLINE', '1')

    print(f"Loading model (cache: {os.environ.get('HF_HOME', 'default')}) …", file=sys.stderr, flush=True)

    clf = SAP_RPT_OSS_Classifier(
        bagging=1,
        max_context_size=512,
    )
    return clf

# ─── Inference ────────────────────────────────────────────────────────────────

def _coerce_dtypes(df, data_schema: dict | None):
    """
    Coerce DataFrame columns to proper dtypes so sap_rpt_oss doesn't warn.
    Uses data_schema hints when available, otherwise infers from values.
    """
    for col in df.columns:
        hint = (data_schema or {}).get(col, {}).get('dtype', '')
        if hint in ('numeric', 'integer', 'float'):
            df[col] = pd.to_numeric(df[col], errors='coerce')
        elif hint in ('bool',):
            df[col] = df[col].astype(bool)
        elif hint in ('date', 'datetime'):
            df[col] = pd.to_datetime(df[col], errors='coerce')
        else:
            # Try int, then float, fall back to string
            try:
                converted = pd.to_numeric(df[col], errors='raise', downcast='integer')
                df[col] = converted
            except (ValueError, TypeError):
                try:
                    converted = pd.to_numeric(df[col], errors='raise')
                    df[col] = converted
                except (ValueError, TypeError):
                    df[col] = df[col].astype(str).replace('None', pd.NA).replace('nan', pd.NA)
    return df


def predict(clf, data: dict) -> dict:
    """
    Run predictions for one request.

    data keys mirror predictRowColumns payload:
      rows              – list of row dicts
      prediction_config – { target_columns: [{name, prediction_placeholder, task_type}] }
      index_column      – name of the ID column
      data_schema       – optional { col: {dtype} } map
    """
    rows = data["rows"]
    prediction_config = data["prediction_config"]
    index_column = data["index_column"]
    data_schema = data.get("data_schema")
    target_cols = [tc["name"] for tc in prediction_config["target_columns"]]
    placeholder = prediction_config["target_columns"][0].get("prediction_placeholder", "[PREDICT]")

    df = _coerce_dtypes(pd.DataFrame(rows), data_schema)

    predictions = []
    for _, row in df.iterrows():
        row_id = row[index_column]
        new_pred = {index_column: row_id}
        needs_prediction = any(
            str(row.get(col)) == placeholder or row.get(col) is None
            for col in target_cols
        )

        if not needs_prediction:
            continue

        # Only predict columns that actually need it for this row
        for col in target_cols:
            if str(row.get(col)) != placeholder and row.get(col) is not None:
                continue

            train_rows = [
                r for r in rows
                if r.get(col) is not None and str(r.get(col)) != placeholder
            ]
            if not train_rows:
                new_pred[col] = [{"prediction": None}]
                continue

            X_train = _coerce_dtypes(pd.DataFrame(train_rows).drop(columns=[col], errors="ignore"), data_schema)
            y_train = pd.DataFrame(train_rows)[col]
            test_row = _coerce_dtypes(df[df[index_column] == row_id].drop(columns=[col], errors="ignore").copy(), data_schema)

            try:
                clf.fit(X_train, y_train)
                probas = clf.predict_proba(test_row)
                classes = clf.classes_
                ranked = sorted(zip(classes, probas[0]), key=lambda x: x[1], reverse=True)[:3]
                new_pred[col] = [{"prediction": str(c), "score": float(p)} for c, p in ranked]
            except Exception as exc:
                new_pred[col] = [{"prediction": None, "error": str(exc)}]

        predictions.append(new_pred)

    return {"predictions": predictions}

# ─── I/O loop ─────────────────────────────────────────────────────────────────

def _respond(msg: dict):
    _real_stdout.write(json.dumps(msg) + "\n")
    _real_stdout.flush()

def _fatal(msg: str):
    print(f"FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

def main():
    model_path = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get("RPT_MODEL_PATH", "")
    )
    if not model_path or not Path(model_path).exists():
        _fatal(f"Model checkpoint not found at '{model_path}'. Pass path as first argument.")

    clf = load_model(model_path)

    _respond({"id": 0, "result": "ready"})
    print("Ready — waiting for requests.", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"Bad JSON: {exc}", file=sys.stderr, flush=True)
            continue

        req_id = req.get("id")
        try:
            result = predict(clf, req["data"])
            _respond({"id": req_id, "result": result})
        except Exception:
            err = traceback.format_exc()
            print(err, file=sys.stderr, flush=True)
            _respond({"id": req_id, "error": err.splitlines()[-1]})

if __name__ == "__main__":
    main()
