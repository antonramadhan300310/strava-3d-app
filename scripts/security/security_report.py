#!/usr/bin/env python3
"""Reporting helpers for .github/workflows/security-audit.yml.

Every scan writes a JSON file into the reports directory; this script turns
those files into the GitHub Step Summary table and decides which findings are
fatal. Only leaked credentials are fatal (Supabase service_role key, private
keys, cloud access tokens); everything else is reported but never fails the run.

Usage:
    security_report.py config-audit --android android --capacitor capacitor.config.ts --out reports/config-audit.json
    security_report.py scan-tree   --root out --out reports/bundle-secrets.json
    security_report.py scan-apk    --apk app.apk --out reports/apk-scan.json
    security_report.py apk-verify  --badging badging.txt --signature signature.txt --out reports/apk-verify.json
    security_report.py classify-jwt --input raw-gitleaks.json --out reports/jwt-roles.json
    security_report.py summary     --reports reports --job sast|mobile|combined
    security_report.py fatal-gate  --reports reports
"""

import argparse
import base64
import binascii
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]
BLOCKING_SEVERITIES = {"critical", "high", "medium"}

# Gitleaks rule ids that mean "a real credential leaked" - these fail the job.
FATAL_GITLEAKS_RULES = {
    "supabase-service-role-key",
    "supabase-service-role-inline",
    "android-keystore-password",
    "private-key",
    "aws-access-token",
    "stripe-access-token",
    "gcp-api-key",
}

ANDROID_NS = "{http://schemas.android.com/apk/res/android}"
SKIP_EXTENSIONS = (
    ".so", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ttf", ".otf", ".woff",
    ".woff2", ".zip", ".gz", ".mp4", ".webm", ".jks", ".keystore", ".ico",
)
MAX_SCAN_BYTES = 20 * 1024 * 1024


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def redact(secret):
    secret = (secret or "").strip()
    if len(secret) <= 12:
        return "***"
    return "%s...%s" % (secret[:6], secret[-4:])


def item(tool, rule, severity, detail, file=None, line=None, secret=None, fatal=False):
    return {
        "tool": tool,
        "rule": rule,
        "severity": severity,
        "fatal": bool(fatal),
        "detail": detail,
        "file": file,
        "line": line,
        "secret": redact(secret) if secret else None,
    }


def write_report(path, tool, items, extra=None):
    counts = {sev: 0 for sev in SEVERITY_ORDER}
    for entry in items:
        counts[entry["severity"]] = counts.get(entry["severity"], 0) + 1
    payload = {
        "tool": tool,
        "items": items,
        "counts": counts,
        "fatal": sum(1 for entry in items if entry["fatal"]),
    }
    if extra:
        payload.update(extra)
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print("%s: %d item(s) -> %s" % (tool, len(items), path))


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def decode_jwt_role(token):
    """Return the `role` claim of a JWT, or None when it cannot be decoded."""
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
        return json.loads(raw.decode("utf-8")).get("role")
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None


JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")

# (rule id, regex, severity, fatal, description)
SECRET_PATTERNS = [
    (
        "private-key",
        re.compile(r"-----BEGIN[ A-Z0-9_]{0,40}PRIVATE KEY(?: BLOCK)?-----"),
        "critical", True,
        "Private key material (PEM) tertanam di artefak.",
    ),
    (
        "supabase-service-role-key",
        re.compile(
            r"(?i)(?:supabase[_-]?service[_-]?role(?:[_-]?key)?|service_role_key)"
            r"\s*[:=]\s*[\"']?(?:eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}|[A-Za-z0-9_\-]{32,})"
        ),
        "critical", True,
        "Supabase service_role key tertanam di artefak.",
    ),
    (
        "supabase-service-role-literal",
        re.compile(r"(?i)[\"']role[\"']\s*:\s*[\"']service_role[\"']"),
        "critical", True,
        "Klaim role service_role (JWT admin Supabase) tertanam di artefak.",
    ),
    (
        "aws-access-token",
        re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
        "critical", True,
        "AWS access key ID tertanam di artefak.",
    ),
    (
        "stripe-live-key",
        re.compile(r"\bsk_live_[0-9a-zA-Z]{20,}"),
        "critical", True,
        "Stripe live secret key tertanam di artefak.",
    ),
    (
        "google-api-key",
        re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
        "high", False,
        "Google API key tertanam; batasi lewat restriction di Google Cloud.",
    ),
    (
        "keystore-password",
        re.compile(r"(?i)(?:storePassword|keyPassword)\s*[:=]\s*[\"'][^\"'\s]{4,}[\"']"),
        "high", False,
        "Password keystore/key Android tertanam di artefak.",
    ),
    (
        "service-role-mention",
        re.compile(r"(?i)service_role"),
        "low", False,
        "Rujukan string service_role (perlu dicek manual bila bukan dokumentasi).",
    ),
]


def scan_text(text, location, tool):
    """Return findings for one text blob. Public JWTs (role=anon) are allowed."""
    results = []
    seen = set()
    for rule, pattern, severity, fatal, detail in SECRET_PATTERNS:
        for match in pattern.finditer(text):
            token = match.group(0)
            key = (rule, location, token[:24])
            if key in seen:
                continue
            seen.add(key)
            results.append(item(tool, rule, severity, detail, location, None, token, fatal))

    for match in JWT_RE.finditer(text):
        token = match.group(0)
        role = decode_jwt_role(token)
        if role == "anon":
            continue  # public Supabase anon/publishable key: expected in the bundle
        key = ("jwt", location, token[:24])
        if key in seen:
            continue
        seen.add(key)
        if role == "service_role":
            results.append(item(
                tool, "supabase-service-role-jwt", "critical",
                "JWT dengan role service_role (melewati RLS) tertanam di artefak.",
                location, None, token, True))
        else:
            results.append(item(
                tool, "jwt", "medium",
                "JWT tidak dikenal (role=%s) tertanam di artefak." % (role or "?"),
                location, None, token, False))
    return results


def read_text(path):
    try:
        if os.path.getsize(path) > MAX_SCAN_BYTES:
            return None
        with open(path, "rb") as handle:
            return handle.read().decode("utf-8", errors="ignore")
    except OSError:
        return None


# ---------------------------------------------------------------------------
# config-audit: AndroidManifest.xml + capacitor.config.*
# ---------------------------------------------------------------------------

def manifest_items(android_dir):
    path = os.path.join(android_dir, "app", "src", "main", "AndroidManifest.xml")
    items = []
    try:
        tree = ET.parse(path)
    except (OSError, ET.ParseError) as error:
        items.append(item("manifest", "manifest-unreadable", "high",
                          "AndroidManifest.xml tidak bisa dibaca: %s" % error, path))
        return items

    root = tree.getroot()
    app = root.find("application")
    if app is None:
        items.append(item("manifest", "manifest-no-application", "high",
                          "Tag <application> tidak ditemukan.", path))
        return items

    def attr(name):
        return app.get(ANDROID_NS + name)

    if (attr("allowBackup") or "").lower() == "false":
        items.append(item("manifest", "allow-backup-disabled", "info",
                          "allowBackup=false: data aplikasi tidak bisa ditarik lewat adb/backup.", path))
    else:
        items.append(item("manifest", "allow-backup-enabled", "medium",
                          "allowBackup tidak false: token sesi di localStorage bisa ditarik lewat adb backup.",
                          path))

    if (attr("debuggable") or "").lower() == "true":
        items.append(item("manifest", "debuggable", "high",
                          "android:debuggable=true: proses bisa di-attach debugger.", path))

    cleartext = (attr("usesCleartextTraffic") or "").lower()
    if cleartext == "true":
        items.append(item("manifest", "cleartext-enabled", "high",
                          "usesCleartextTraffic=true: trafik HTTP polos diizinkan.", path))
    elif cleartext == "false":
        items.append(item("manifest", "cleartext-disabled", "info",
                          "usesCleartextTraffic=false: hanya HTTPS.", path))
    else:
        items.append(item("manifest", "cleartext-implicit", "low",
                          "usesCleartextTraffic tidak diset (default false untuk targetSdk>=28).", path))

    if attr("networkSecurityConfig"):
        items.append(item("manifest", "network-security-config", "info",
                          "networkSecurityConfig=%s." % attr("networkSecurityConfig"), path))
    else:
        items.append(item("manifest", "no-network-security-config", "low",
                          "Tidak ada networkSecurityConfig eksplisit.", path))

    for tag in ("activity", "activity-alias", "service", "receiver", "provider"):
        for node in app.findall(tag):
            name = node.get(ANDROID_NS + "name") or "?"
            if (node.get(ANDROID_NS + "exported") or "").lower() != "true":
                continue
            launcher = any(
                any(c.get(ANDROID_NS + "name") == "android.intent.category.LAUNCHER" for c in f)
                for f in node.findall("intent-filter")
            )
            if launcher:
                items.append(item("manifest", "exported-launcher", "info",
                                  "%s exported=true karena launcher activity (wajar)." % name, path))
            elif tag == "activity":
                items.append(item("manifest", "exported-activity", "medium",
                                  "%s exported=true tanpa intent-filter launcher." % name, path))
            else:
                items.append(item("manifest", "exported-component", "medium",
                                  "%s (%s) exported=true: komponen bisa dipanggil aplikasi lain."
                                  % (name, tag), path))

            launch_mode = node.get(ANDROID_NS + "launchMode") or ""
            if launch_mode in ("singleTask", "singleInstance"):
                items.append(item("manifest", "task-hijacking", "low",
                                  "%s memakai launchMode=%s (StrandHogg 2.0 hardening butuh "
                                  "taskAffinity=\"\" plus uji ulang deep link)." % (name, launch_mode),
                                  path))

    for node in root.findall("uses-permission"):
        name = node.get(ANDROID_NS + "name") or ""
        if name in ("android.permission.READ_EXTERNAL_STORAGE",
                    "android.permission.WRITE_EXTERNAL_STORAGE"):
            items.append(item("manifest", "legacy-storage-permission", "low",
                              "%s diminta (dibatasi maxSdkVersion)." % name, path))

    for filter_node in root.iter("intent-filter"):
        for data in filter_node.findall("data"):
            scheme = data.get(ANDROID_NS + "scheme")
            if scheme:
                items.append(item("manifest", "deep-link", "info",
                                  "Deep link scheme=%s host=%s (OAuth callback)."
                                  % (scheme, data.get(ANDROID_NS + "host")), path))
    return items


def capacitor_items(capacitor_path):
    items = []
    text = read_text(capacitor_path) if os.path.exists(capacitor_path) else None
    if text is None:
        items.append(item("capacitor", "config-missing", "medium",
                          "capacitor.config.* tidak ditemukan.", capacitor_path))
        return items

    if re.search(r"androidScheme\s*:\s*['\"]https['\"]", text):
        items.append(item("capacitor", "android-scheme-https", "info",
                          "androidScheme=https (WebView disajikan lewat origin aman).", capacitor_path))
    else:
        items.append(item("capacitor", "android-scheme-insecure", "high",
                          "androidScheme bukan 'https'.", capacitor_path))

    if re.search(r"cleartext\s*:\s*true", text):
        items.append(item("capacitor", "cleartext-true", "high",
                          "cleartext: true di konfigurasi Capacitor.", capacitor_path))

    for match in re.finditer(r"url\s*:\s*['\"]([^'\"]+)['\"]", text):
        url = match.group(1)
        severity = "high" if url.startswith("http://") else "medium"
        items.append(item("capacitor", "server-url", severity,
                          "server.url=%s (live-reload; pastikan tidak ikut build rilis)." % url,
                          capacitor_path))

    if re.search(r"allowNavigation\s*:\s*\[[^\]]*['\"]\*['\"]", text):
        items.append(item("capacitor", "allow-navigation-wildcard", "high",
                          "allowNavigation berisi '*': WebView boleh membuka host mana pun.",
                          capacitor_path))
    return items


def cmd_config_audit(args):
    items = manifest_items(args.android) + capacitor_items(args.capacitor)
    write_report(args.out, "config-audit", items)


# ---------------------------------------------------------------------------
# scan-tree / scan-apk: secrets inside the built web bundle and the APK
# ---------------------------------------------------------------------------

def cmd_scan_tree(args):
    items = []
    scanned = 0
    for root, _dirs, files in os.walk(args.root):
        for name in files:
            if name.endswith(SKIP_EXTENSIONS):
                continue
            path = os.path.join(root, name)
            text = read_text(path)
            if text is None:
                continue
            scanned += 1
            items.extend(scan_text(text, os.path.relpath(path, args.root), "bundle-secrets"))
    write_report(args.out, "bundle-secrets", items, {"scanned_files": scanned, "root": args.root})


def cmd_scan_apk(args):
    items = []
    scanned = 0
    entries = 0
    has_web_bundle = False
    try:
        archive = zipfile.ZipFile(args.apk)
    except (OSError, zipfile.BadZipFile) as error:
        write_report(args.out, "apk-secrets",
                     [item("apk-secrets", "apk-unreadable", "high",
                           "APK tidak bisa dibuka: %s" % error, args.apk)])
        return

    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            entries += 1
            if info.filename.startswith("assets/public/"):
                has_web_bundle = True
            if info.filename.endswith(SKIP_EXTENSIONS) or info.file_size > MAX_SCAN_BYTES:
                continue
            try:
                blob = archive.read(info)
            except (OSError, RuntimeError, zipfile.BadZipFile):
                continue
            scanned += 1
            items.extend(scan_text(blob.decode("utf-8", errors="ignore"),
                                   info.filename, "apk-secrets"))

    write_report(args.out, "apk-secrets", items, {
        "scanned_files": scanned,
        "entries": entries,
        "has_web_bundle": has_web_bundle,
        "apk": os.path.basename(args.apk),
    })


# ---------------------------------------------------------------------------
# apk-verify: aapt badging + apksigner output
# ---------------------------------------------------------------------------

def cmd_apk_verify(args):
    items = []
    badging = read_text(args.badging) or ""
    signature = read_text(args.signature) or ""

    if not badging:
        items.append(item("apk-verify", "badging-missing", "medium",
                          "Output aapt/aapt2 badging kosong.", args.badging))
    else:
        package = re.search(
            r"package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'", badging)
        if package:
            items.append(item("apk-verify", "package", "info",
                              "%s versionCode=%s versionName=%s"
                              % (package.group(1), package.group(2), package.group(3))))
        target = re.search(r"targetSdkVersion:'(\d+)'", badging)
        if target:
            items.append(item("apk-verify", "target-sdk", "info",
                              "targetSdkVersion=%s" % target.group(1)))
        if "application-debuggable" in badging:
            items.append(item("apk-verify", "debuggable", "high",
                              "APK ditandai debuggable."))
        else:
            items.append(item("apk-verify", "not-debuggable", "info",
                              "APK tidak debuggable."))

    if not signature:
        items.append(item("apk-verify", "signature-missing", "medium",
                          "Output apksigner kosong.", args.signature))
    else:
        if "DOES NOT VERIFY" in signature:
            items.append(item("apk-verify", "signature-invalid", "high",
                              "apksigner: verifikasi signature gagal."))
        elif re.search(r"^Verifies$", signature, re.M):
            items.append(item("apk-verify", "signature-verified", "info",
                              "apksigner: signature valid."))
        # apksigner prints "Signer #1 certificate DN:" for JAR (v1) signers and
        # "V2 Signer: certificate DN:" / "V3 Signer:" for the newer schemes.
        dn = re.search(r"(?:Signer #\d+|V\d Signer):? certificate DN: (.+)", signature)
        if dn:
            subject = dn.group(1).strip()
            if "Android Debug" in subject:
                items.append(item("apk-verify", "debug-signature", "high",
                                  "APK ditandatangani debug key (%s)." % subject))
            else:
                items.append(item("apk-verify", "release-signature", "info",
                                  "APK ditandatangani: %s" % subject))
        schemes = re.findall(r"Verified using (v[0-9.]+) scheme \([^)]*\): (true|false)", signature)
        used = sorted(set(re.findall(r"^(V\d) Signer:", signature, re.M)))
        if schemes:
            items.append(item("apk-verify", "signature-schemes", "info",
                              ", ".join("%s=%s" % (name, value) for name, value in schemes)))
        elif used:
            items.append(item("apk-verify", "signature-schemes", "info",
                              "scheme aktif: %s" % ", ".join(used)))
        elif not dn:
            items.append(item("apk-verify", "signature-unparsed", "medium",
                              "Tidak ada informasi signer pada output apksigner."))

    write_report(args.out, "apk-verify", items)


# ---------------------------------------------------------------------------
# classify-jwt: decode JWTs found by gitleaks (raw report, never uploaded)
# ---------------------------------------------------------------------------

def cmd_classify_jwt(args):
    raw = load_json(args.input) or []
    items = []
    for entry in raw:
        secret = entry.get("Secret") or ""
        if "eyJ" not in secret:
            continue
        role = decode_jwt_role(secret)
        where = entry.get("File")
        line = entry.get("StartLine")
        if role == "service_role":
            items.append(item("gitleaks-jwt", "supabase-service-role-jwt", "critical",
                              "JWT role=service_role ditemukan di riwayat commit.",
                              where, line, secret, True))
        elif role == "anon":
            items.append(item("gitleaks-jwt", "public-anon-jwt", "info",
                              "JWT role=anon (kunci publik, bukan kebocoran).",
                              where, line, secret, False))
        else:
            items.append(item("gitleaks-jwt", "jwt-unknown-role", "medium",
                              "JWT role=%s di riwayat commit." % (role or "?"),
                              where, line, secret, False))
    write_report(args.out, "gitleaks-jwt", items)


# ---------------------------------------------------------------------------
# summary / fatal-gate
# ---------------------------------------------------------------------------

def gitleaks_items(path):
    raw = load_json(path)
    if raw is None:
        return None
    items = []
    for entry in raw:
        rule = entry.get("RuleID") or "unknown"
        fatal = rule in FATAL_GITLEAKS_RULES
        items.append(item("gitleaks", rule, "critical" if fatal else "medium",
                          entry.get("Description") or rule,
                          entry.get("File"), entry.get("StartLine"), fatal=fatal))
    return items


def sarif_items(path, tool):
    data = load_json(path)
    if data is None:
        return None
    items = []
    for run in data.get("runs", []):
        rules = run.get("tool", {}).get("driver", {}).get("rules", [])
        for result in run.get("results", []):
            locations = result.get("locations") or [{}]
            physical = locations[0].get("physicalLocation", {})
            rule_id = result.get("ruleId") or "unknown"
            level = result.get("level")
            if not level and rules:
                index = result.get("ruleIndex", 0)
                if index < len(rules):
                    level = rules[index].get("defaultConfiguration", {}).get("level")
            severity = {"error": "high", "warning": "medium", "note": "low"}.get(level or "", "low")
            score = (result.get("properties") or {}).get("security-severity")
            if score:
                try:
                    numeric = float(score)
                    severity = ("critical" if numeric >= 9 else "high" if numeric >= 7
                                else "medium" if numeric >= 4 else "low")
                except ValueError:
                    pass
            message = result.get("message")
            if isinstance(message, dict):
                message = message.get("text")
            items.append(item(tool, rule_id, severity, (message or "").splitlines()[0][:160],
                              physical.get("artifactLocation", {}).get("uri"),
                              (physical.get("region") or {}).get("startLine")))
    return items


def npm_audit_counts(path):
    data = load_json(path)
    if data is None:
        return None
    meta = (data.get("metadata") or {}).get("vulnerabilities") or {}
    return {key: int(meta.get(key, 0))
            for key in ("info", "low", "moderate", "high", "critical", "total")}


def apkleaks_items(path):
    data = load_json(path)
    if data is None:
        return None
    items = []
    for group in data.get("results", []):
        name = group.get("name") or "unknown"
        matches = group.get("matches") or []
        produced = []
        for match in matches:
            produced.extend(scan_text(str(match), "apkleaks:%s" % name, "apkleaks"))
        items.extend(produced)
        if matches and not produced:
            # Everything this pattern found was allowlisted (e.g. the public
            # Supabase anon key), so record it as information only.
            items.append(item("apkleaks", name, "info",
                              "%d kecocokan, semuanya kunci publik (bukan kebocoran)."
                              % len(matches)))
    return items


def collect(reports_dir):
    """Load every report into one dict of tool -> items|counts."""
    return {
        "gitleaks": gitleaks_items(os.path.join(reports_dir, "gitleaks.json")),
        "jwt": (load_json(os.path.join(reports_dir, "jwt-roles.json")) or {}).get("items"),
        "semgrep": sarif_items(os.path.join(reports_dir, "semgrep.sarif"), "semgrep"),
        "npm": npm_audit_counts(os.path.join(reports_dir, "npm-audit.json")),
        "mobsfscan": sarif_items(os.path.join(reports_dir, "mobsfscan.sarif"), "mobsfscan"),
        "config": (load_json(os.path.join(reports_dir, "config-audit.json")) or {}).get("items"),
        "bundle": (load_json(os.path.join(reports_dir, "bundle-secrets.json")) or {}).get("items"),
        "apkleaks": apkleaks_items(os.path.join(reports_dir, "apkleaks.json")),
        "apk": (load_json(os.path.join(reports_dir, "apk-scan.json")) or {}).get("items"),
        "apkverify": (load_json(os.path.join(reports_dir, "apk-verify.json")) or {}).get("items"),
    }


SAST_KEYS = ("gitleaks", "jwt")
MOBILE_KEYS = ("bundle", "apk", "apkleaks")


def fatal_items(reports_dir, keys=None):
    data = collect(reports_dir)
    fatal = []
    for key in keys or SAST_KEYS + MOBILE_KEYS:
        for entry in data.get(key) or []:
            if entry.get("fatal"):
                fatal.append(entry)
    return fatal


def count_severities(items):
    counts = {sev: 0 for sev in SEVERITY_ORDER}
    for entry in items or []:
        counts[entry["severity"]] = counts.get(entry["severity"], 0) + 1
    return counts


STATUS_LABEL = {
    "PASS": "\u2705 Lulus",
    "REVIEW": "\u26a0\ufe0f Tinjau",
    "FAIL": "\u274c Gagal",
    "SKIP": "\u23ed\ufe0f Dilewati",
}


def status_of(items, fatal=0):
    if fatal:
        return "FAIL"
    counts = count_severities(items)
    if any(counts[sev] for sev in BLOCKING_SEVERITIES):
        return "REVIEW"
    return "PASS"


def table_row(name, items, note, fatal=0, skipped_reason=None):
    if items is None:
        return "| %s | %s | - | %s |" % (name, STATUS_LABEL["SKIP"],
                                         skipped_reason or "tidak dijalankan")
    counts = count_severities(items)
    summary = ", ".join("%s %d" % (sev, counts[sev])
                        for sev in SEVERITY_ORDER if counts[sev]) or "0"
    return "| %s | %s | %d | %s (%s) |" % (
        name, STATUS_LABEL[status_of(items, fatal)], len(items), note, summary)


def details_section(title, items, limit=10):
    if not items:
        return ""
    lines = ["", "<details><summary>%s (%d)</summary>" % (title, len(items)), "",
             "| Rule | Severity | Lokasi | Detail |", "| --- | --- | --- | --- |"]
    for entry in items[:limit]:
        location = entry.get("file") or "-"
        if entry.get("line"):
            location = "%s:%s" % (location, entry["line"])
        detail = (entry.get("detail") or "").replace("|", "\\|")[:160]
        lines.append("| `%s` | %s | `%s` | %s |"
                     % (entry.get("rule"), entry.get("severity"), location, detail))
    if len(items) > limit:
        lines.append("")
        lines.append("_%d temuan lain ada di artifact `security-audit-reports`._"
                     % (len(items) - limit))
    lines.extend(["", "</details>"])
    return "\n".join(lines)


def cmd_summary(args):
    data = collect(args.reports)
    job = args.job
    keys = {"sast": SAST_KEYS, "mobile": MOBILE_KEYS}.get(job)
    fatal = fatal_items(args.reports, keys)
    out = [
        "## Security Audit ALLMOVA",
        "",
        "Mode: `%s` - Commit: `%s`"
        % (os.environ.get("AUDIT_MODE", "-"), (os.environ.get("GITHUB_SHA") or "-")[:12]),
        "",
        "Audit berjalan statis di runner: tidak ada satu pun request ke Supabase live.",
        "",
        "| Pemeriksaan | Status | Temuan | Ringkasan |",
        "| --- | --- | --- | --- |",
    ]

    if job in ("sast", "combined"):
        gitleaks = data["gitleaks"]
        out.append(table_row("Gitleaks (kode + riwayat commit)", gitleaks,
                             "kebocoran kredensial",
                             fatal=sum(1 for e in gitleaks or [] if e["fatal"]),
                             skipped_reason="report tidak ada"))
        out.append(table_row("Pemeriksaan JWT (anon vs service_role)", data["jwt"],
                             "kunci publik diizinkan", skipped_reason="report tidak ada"))
        out.append(table_row("Semgrep (typescript/react/nextjs/owasp)",
                             data["semgrep"], "temuan SAST", skipped_reason="report tidak ada"))
        npm = data["npm"]
        if npm is None:
            out.append("| npm audit (--audit-level=high) | SKIP | - | report tidak ada |")
        else:
            blocking = npm["critical"] + npm["high"]
            out.append("| npm audit (--audit-level=high) | %s | %d | critical %d, high %d, moderate %d |"
                       % (STATUS_LABEL["REVIEW" if blocking else "PASS"], npm["total"],
                          npm["critical"], npm["high"], npm["moderate"]))

    if job in ("mobile", "combined"):
        out.append(table_row("mobsfscan (konfigurasi native android/)", data["mobsfscan"],
                             "manifest & cleartext", skipped_reason="report tidak ada"))
        out.append(table_row("Audit manifest + capacitor.config", data["config"],
                             "allowBackup/cleartext/exported", skipped_reason="report tidak ada"))
        out.append(table_row("Kredensial di web bundle (out/)", data["bundle"],
                             "hasil npm run build", skipped_reason="report tidak ada"))
        out.append(table_row("APKLeaks (isi APK)", data["apkleaks"],
                             "endpoint & kredensial di APK", skipped_reason="APK tidak dipindai"))
        out.append(table_row("Kredensial di dalam APK", data["apk"],
                             "assets/ + dex", skipped_reason="APK tidak dipindai"))
        out.append(table_row("Verifikasi APK (debuggable/signature)", data["apkverify"],
                             "aapt2 + apksigner", skipped_reason="APK tidak dipindai"))

    out.append("")
    if fatal:
        out.append("### Kebocoran fatal - job digagalkan")
        out.append("")
        for entry in fatal[:20]:
            out.append("- `%s` di `%s` (%s) - %s"
                       % (entry.get("rule"), entry.get("file") or "-",
                          entry.get("secret") or "-", entry.get("detail")))
        out.extend(["", "Rotasi kredensial tersebut, hapus dari riwayat git, lalu jalankan ulang audit."])
    else:
        out.append("Tidak ada kebocoran secret fatal. Temuan medium/low bersifat report-only.")

    if job in ("sast", "combined"):
        out.append(details_section("Detail Gitleaks", data["gitleaks"]))
        out.append(details_section("Detail Semgrep", data["semgrep"]))
    if job in ("mobile", "combined"):
        out.append(details_section("Detail mobsfscan", data["mobsfscan"]))
        out.append(details_section("Detail konfigurasi", data["config"]))
        out.append(details_section("Detail secret di bundle", data["bundle"]))
        out.append(details_section("Detail APKLeaks", data["apkleaks"]))
        out.append(details_section("Detail secret di APK", data["apk"]))
        out.append(details_section("Detail verifikasi APK", data["apkverify"]))

    text = "\n".join(out) + "\n"
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)


def cmd_fatal_gate(args):
    fatal = fatal_items(args.reports)
    if not fatal:
        print("fatal-gate: tidak ada kebocoran secret fatal.")
        return 0
    for entry in fatal:
        print("::error title=Kebocoran secret fatal::%s di %s (%s)"
              % (entry.get("rule"), entry.get("file") or "-", entry.get("secret") or "-"))
    print("fatal-gate: %d kebocoran fatal terdeteksi." % len(fatal))
    return 1


# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ALLMOVA security audit reporting")
    sub = parser.add_subparsers(dest="command", required=True)

    config_audit = sub.add_parser("config-audit")
    config_audit.add_argument("--android", default="android")
    config_audit.add_argument("--capacitor", default="capacitor.config.ts")
    config_audit.add_argument("--out", required=True)

    scan_tree = sub.add_parser("scan-tree")
    scan_tree.add_argument("--root", required=True)
    scan_tree.add_argument("--out", required=True)

    scan_apk = sub.add_parser("scan-apk")
    scan_apk.add_argument("--apk", required=True)
    scan_apk.add_argument("--out", required=True)

    apk_verify = sub.add_parser("apk-verify")
    apk_verify.add_argument("--badging", required=True)
    apk_verify.add_argument("--signature", required=True)
    apk_verify.add_argument("--out", required=True)

    classify_jwt = sub.add_parser("classify-jwt")
    classify_jwt.add_argument("--input", required=True)
    classify_jwt.add_argument("--out", required=True)

    summary = sub.add_parser("summary")
    summary.add_argument("--reports", default="reports")
    summary.add_argument("--job", default="combined", choices=["sast", "mobile", "combined"])
    summary.add_argument("--out")

    gate = sub.add_parser("fatal-gate")
    gate.add_argument("--reports", default="reports")

    args = parser.parse_args()
    handlers = {
        "config-audit": cmd_config_audit,
        "scan-tree": cmd_scan_tree,
        "scan-apk": cmd_scan_apk,
        "apk-verify": cmd_apk_verify,
        "classify-jwt": cmd_classify_jwt,
        "summary": cmd_summary,
        "fatal-gate": cmd_fatal_gate,
    }
    return handlers[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
