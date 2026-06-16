#!/usr/bin/env python3
"""Download & extract Taiwan 20 m DTM county tiles from the TGOS product list.

Reads the official CSV catalogue (圖資名稱, …, 連結網址) and, for every
"分幅_<縣市>20MDEM(2025)" row, downloads its zip and extracts the flat
`<id>dem.grd` / `<id>dem.hdr` tiles into `raw/<slug>/`.

Usage:
  python3 scripts/fetch_dtm.py sources.csv --out raw
  python3 scripts/fetch_dtm.py sources.csv --out raw --only taipei newtaipei keelung
"""

import argparse
import csv
import re
import subprocess
import sys
import zipfile
from io import BytesIO
from pathlib import Path

# Chinese county name (as embedded in 圖資名稱) → ASCII slug for the raw/ dir.
SLUG = {
    '臺北市': 'taipei',        '新北市': 'newtaipei',     '基隆市': 'keelung',
    '桃園市': 'taoyuan',       '新竹縣': 'hsinchu-county', '新竹市': 'hsinchu-city',
    '苗栗縣': 'miaoli',        '臺中市': 'taichung',      '彰化縣': 'changhua',
    '南投縣': 'nantou',        '雲林縣': 'yunlin',        '嘉義縣': 'chiayi-county',
    '嘉義市': 'chiayi-city',   '臺南市': 'tainan',        '高雄市': 'kaohsiung',
    '屏東縣': 'pingtung',      '宜蘭縣': 'yilan',         '花蓮縣': 'hualien',
    '臺東縣': 'taitung',       '澎湖縣': 'penghu',        '金門縣': 'kinmen',
    '連江縣': 'lienchiang',
}

# Outlying islands: far offshore — must NOT be merged into the main-island mesh.
OUTLYING = {'penghu', 'kinmen', 'lienchiang'}

NAME_RE = re.compile(r'^分幅_(.+?)20MDEM')


def parse_catalogue(csv_path: Path) -> list[tuple[str, str, str]]:
    """Return [(slug, county_name, url)] for every 分幅 county row."""
    rows: list[tuple[str, str, str]] = []
    with csv_path.open(encoding='utf-8-sig') as fh:
        for rec in csv.DictReader(fh):
            name = rec['圖資名稱'].strip()
            m = NAME_RE.match(name)
            if not m:
                continue
            county = m.group(1)
            slug = SLUG.get(county)
            if slug is None:
                print(f'  [warn] unmapped county: {county!r}', file=sys.stderr)
                continue
            rows.append((slug, county, rec['連結網址'].strip()))
    return rows


def fetch_and_extract(slug: str, url: str, out_dir: Path) -> int:
    """Download one county zip and extract its .grd/.hdr tiles. Returns tile count."""
    dest = out_dir / slug
    dest.mkdir(parents=True, exist_ok=True)

    # Fetch via curl: it percent-encodes the CJK zip name in the path itself and
    # tolerates the TGOS server cert defect ("Missing Subject Key Identifier")
    # that Python's strict OpenSSL rejects.
    proc = subprocess.run(
        ['curl', '-sfL', '--max-time', '120', url],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f'curl exit {proc.returncode}: {proc.stderr.decode(errors="replace")[:200]}')
    blob = proc.stdout

    extracted = 0
    with zipfile.ZipFile(BytesIO(blob)) as z:
        for member in z.namelist():
            base = Path(member).name
            if base.endswith(('dem.grd', 'dem.hdr', 'manifest.csv')):
                (dest / base).write_bytes(z.read(member))
                if base.endswith('dem.grd'):
                    extracted += 1
    return extracted


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv', type=Path, help='TGOS DTM catalogue CSV')
    ap.add_argument('--out', type=Path, default=Path('raw'), help='Output root dir')
    ap.add_argument('--only', nargs='*', metavar='SLUG',
                    help='Only fetch these slugs (default: all)')
    ap.add_argument('--skip-existing', action='store_true',
                    help='Skip a county whose raw/<slug>/ already has tiles')
    ap.add_argument('--main-island', action='store_true',
                    help='Exclude outlying islands (Penghu/Kinmen/Lienchiang)')
    args = ap.parse_args()

    catalogue = parse_catalogue(args.csv)
    if args.only:
        wanted = set(args.only)
        catalogue = [r for r in catalogue if r[0] in wanted]
    if args.main_island:
        catalogue = [r for r in catalogue if r[0] not in OUTLYING]

    print(f'=== {len(catalogue)} counties to fetch ===')
    for i, (slug, county, url) in enumerate(catalogue, 1):
        tag = ' [outlying]' if slug in OUTLYING else ''
        dest = args.out / slug
        if args.skip_existing and any(dest.glob('*dem.grd')):
            print(f'[{i:2}/{len(catalogue)}] {county} ({slug}){tag}: skip (exists)')
            continue
        try:
            n = fetch_and_extract(slug, url, args.out)
            print(f'[{i:2}/{len(catalogue)}] {county} ({slug}){tag}: {n} tiles')
        except Exception as exc:  # noqa: BLE001 — report and continue the batch
            print(f'[{i:2}/{len(catalogue)}] {county} ({slug}){tag}: FAILED — {exc}',
                  file=sys.stderr)


if __name__ == '__main__':
    main()
