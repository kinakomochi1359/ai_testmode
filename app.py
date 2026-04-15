import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)
DB_PATH = "library.db"

# ================================================================
# 国立国会図書館 SRU API
# ================================================================
NDL_SRU_URL       = "https://ndlsearch.ndl.go.jp/api/sru"
NDL_THUMBNAIL_URL = "https://ndlsearch.ndl.go.jp/thumbnail/{isbn}.jpg"
NDL_BOOK_URL      = "https://ndlsearch.ndl.go.jp/books/R100000002-I{bib_id}"

# XML 名前空間
_DC    = "http://purl.org/dc/elements/1.1/"
_DCT   = "http://purl.org/dc/terms/"
_DCNDL = "http://ndl.go.jp/dcndl/terms/"
_SRW   = "http://www.loc.gov/zing/srw/"
_RDF   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_FOAF  = "http://xmlns.com/foaf/0.1/"
_RDFS  = "http://www.w3.org/2000/01/rdf-schema#"


def _tag(ns, local):
    return f"{{{ns}}}{local}"


def _text_of(el):
    """要素の直接テキストを返す。foaf:name がネストされていれば優先する。"""
    if el is None:
        return ""
    # foaf:Agent / foaf:Organization 内の foaf:name を探す
    for agent_tag in (_tag(_FOAF, "Agent"), _tag(_FOAF, "Organization")):
        agent = el.find(agent_tag)
        if agent is not None:
            name = agent.find(_tag(_FOAF, "name"))
            if name is not None and name.text:
                return name.text.strip()
    # 直接 foaf:name
    name = el.find(_tag(_FOAF, "name"))
    if name is not None and name.text:
        return name.text.strip()
    # 直接テキスト
    if el.text and el.text.strip():
        return el.text.strip()
    return ""


def _all_texts(parent, clark_tag):
    """parent 直下の clark_tag 要素すべてのテキストをリストで返す。"""
    return [t for el in parent.findall(clark_tag) if (t := _text_of(el))]


def _first(parent, *clark_tags):
    """複数の clark_tag を試して最初に見つかったテキストを返す。"""
    for tag in clark_tags:
        for el in parent.iter(tag):
            t = _text_of(el)
            if t:
                return t
    return ""


def lookup_ndl(isbn: str):
    """
    国立国会図書館サーチ SRU API で ISBN を照会し、書誌情報を返す。
    Returns: (info_dict, None) | (None, error_str)
    """
    isbn_clean = re.sub(r"[^0-9Xx]", "", isbn)
    if len(isbn_clean) not in (10, 13):
        return None, "ISBN は 10 桁または 13 桁で入力してください"

    params = urllib.parse.urlencode({
        "operation":      "searchRetrieve",
        "recordSchema":   "dcndl",
        "query":          f'isbn="{isbn_clean}"',
        "maximumRecords": "1",
    })
    url = f"{NDL_SRU_URL}?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "LibrarySystem/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            xml_bytes = resp.read()
    except urllib.error.URLError as e:
        return None, f"NDL API への接続に失敗しました: {e.reason}"

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        return None, f"API レスポンスの解析に失敗しました: {e}"

    num_el = root.find(_tag(_SRW, "numberOfRecords"))
    if num_el is None or num_el.text == "0":
        return None, "該当する書籍が見つかりませんでした"

    # BibResource 要素を探す
    bib = root.find(f".//{_tag(_DCNDL, 'BibResource')}")
    if bib is None:
        bib = root  # フォールバック

    # ---- 識別子 ----
    about   = bib.get(_tag(_RDF, "about"), "")
    bib_id  = about.rstrip("/").split("/")[-1] if about else ""
    ndl_uri = about

    # ISBN / ISSN を dc:identifier から抽出
    found_isbn = ""
    found_issn = ""
    for id_el in bib.findall(_tag(_DC, "identifier")):
        val = (id_el.text or "").strip()
        if re.match(r"97[89]", val.replace("-", "")):
            found_isbn = found_isbn or val
        elif re.match(r"\d{4}-\d{3}[\dX]", val, re.I):
            found_issn = found_issn or val

    # ---- タイトル情報 ----
    title          = _first(bib, _tag(_DC, "title"))
    title_kana     = _first(bib, _tag(_DCNDL, "titleTranscription"))
    parallel_title = _first(bib, _tag(_DCNDL, "parallelTitle"))
    edition        = _first(bib, _tag(_DCNDL, "edition"))
    volume         = _first(bib, _tag(_DCNDL, "volume"))

    # シリーズタイトル（isPartOf や seriesTitle を探す）
    series_title = ""
    for tag in (_tag(_DCNDL, "seriesTitle"), _tag(_DCT, "isPartOf")):
        el = bib.find(tag)
        if el is not None:
            series_title = _text_of(el) or _first(el, _tag(_DC, "title"))
            if series_title:
                break

    # ---- 責任表示・出版情報 ----
    responsibility = _first(bib, _tag(_DCNDL, "responsibility"))
    authors        = _all_texts(bib, _tag(_DC, "creator"))
    author         = " ; ".join(authors)

    publisher = _text_of(bib.find(_tag(_DC, "publisher"))) if bib.find(_tag(_DC, "publisher")) is not None else ""

    # 出版地：Publisher の dcndl:placeOfPublication または BibResource 直下
    pub_place = _first(bib, _tag(_DCNDL, "placeOfPublication"))

    pub_date  = _first(bib, _tag(_DC, "date"))
    issued    = _first(bib, _tag(_DCT, "issued"))
    year_m    = re.search(r"\d{4}", issued or pub_date)
    year      = int(year_m.group()) if year_m else None

    extent = _first(bib, _tag(_DCT, "extent"))

    # ---- 分類・件名 ----
    ndc      = ""
    ndlc     = ""
    subjects = []
    for el in bib.iter(_tag(_DC, "subject")):
        resource = el.get(_tag(_RDF, "resource"), "")
        if resource:
            # URI から NDC コードを抽出  例: http://id.ndl.go.jp/class/ndc10/014.72
            m = re.search(r"/class/ndc\d*/(.+)$", resource)
            if m:
                ndc = ndc or m.group(1)
            m2 = re.search(r"/class/ndlc/(.+)$", resource)
            if m2:
                ndlc = ndlc or m2.group(1)
        else:
            t = _text_of(el)
            if t:
                subjects.append(t)
    # dcndl:NDC / dcndl:NDLC が別途ある場合
    ndc  = ndc  or _first(bib, _tag(_DCNDL, "NDC"))
    ndlc = ndlc or _first(bib, _tag(_DCNDL, "NDLC"))

    subject    = " ; ".join(subjects)
    genre_form = _first(bib, _tag(_DCNDL, "genreForm"))
    call_number = _first(bib, _tag(_DCNDL, "callNumber"))

    # ---- 補足情報 ----
    notes_list  = _all_texts(bib, _tag(_DC, "description"))
    notes       = " ; ".join(notes_list)
    language    = _first(bib, _tag(_DC, "language"))
    material_type = _first(bib, _tag(_DCNDL, "materialType"))
    material_form = _first(bib, _tag(_DCNDL, "materialForm"))

    # アクセス URL（foaf:page や rdfs:seeAlso）
    access_url = ""
    for tag in (_tag(_FOAF, "page"), _tag(_RDFS, "seeAlso")):
        el = bib.find(tag)
        if el is not None:
            access_url = el.get(_tag(_RDF, "resource"), el.text or "")
            if access_url:
                break
    if not access_url and bib_id:
        access_url = NDL_BOOK_URL.format(bib_id=bib_id)

    # 書影 URL
    isbn13 = re.sub(r"[^0-9]", "", found_isbn or isbn_clean)
    thumbnail_url = NDL_THUMBNAIL_URL.format(isbn=isbn13) if len(isbn13) == 13 else None

    return {
        "ndl_bib_id":     bib_id,
        "ndl_uri":        ndl_uri,
        "isbn":           found_isbn or isbn_clean,
        "issn":           found_issn,
        "title":          title,
        "title_kana":     title_kana,
        "parallel_title": parallel_title,
        "series_title":   series_title,
        "edition":        edition,
        "volume":         volume,
        "responsibility": responsibility,
        "author":         author,
        "publisher":      publisher,
        "pub_place":      pub_place,
        "pub_date":       pub_date,
        "year":           year,
        "extent":         extent,
        "ndc":            ndc,
        "ndlc":           ndlc,
        "subject":        subject,
        "genre_form":     genre_form,
        "call_number":    call_number,
        "notes":          notes,
        "language":       language,
        "material_type":  material_type,
        "material_form":  material_form,
        "access_url":     access_url,
        "thumbnail_url":  thumbnail_url,
    }, None


# ================================================================
# DB helper
# ================================================================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ================================================================
# 一般画面
# ================================================================
@app.route("/")
def index():
    db     = get_db()
    genres = [r["genre"] for r in db.execute(
        "SELECT DISTINCT genre FROM books ORDER BY genre").fetchall()]
    db.close()
    return render_template("index.html", genres=genres)


@app.route("/api/search")
def search():
    query          = request.args.get("q", "").strip()
    genre          = request.args.get("genre", "").strip()
    available_only = request.args.get("available_only", "") == "1"

    sql    = "SELECT * FROM books WHERE 1=1"
    params = []
    if query:
        sql += " AND (title LIKE ? OR author LIKE ? OR responsibility LIKE ? OR isbn LIKE ?)"
        like = f"%{query}%"
        params += [like, like, like, like]
    if genre:
        sql += " AND genre = ?"
        params.append(genre)
    if available_only:
        sql += " AND available = 1"
    sql += " ORDER BY title"

    db   = get_db()
    rows = db.execute(sql, params).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/book/<int:book_id>")
def book_detail(book_id):
    db   = get_db()
    book = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    db.close()
    if book is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(book))


# ================================================================
# 職業別
# ================================================================
@app.route("/api/occupations")
def list_occupations():
    db   = get_db()
    rows = db.execute("""
        SELECT o.id, o.name, o.description, o.icon,
               COUNT(ob.id) AS book_count
        FROM occupations o
        LEFT JOIN occupation_books ob ON ob.occupation_id = o.id
        GROUP BY o.id ORDER BY o.id
    """).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/occupations/<int:occupation_id>/books")
def occupation_books(occupation_id):
    available_only = request.args.get("available_only", "") == "1"
    sql    = """SELECT b.*, ob.note FROM occupation_books ob
                JOIN books b ON b.isbn = ob.isbn
                WHERE ob.occupation_id = ?"""
    params = [occupation_id]
    if available_only:
        sql += " AND b.available = 1"
    sql += " ORDER BY b.title"

    db  = get_db()
    occ = db.execute("SELECT * FROM occupations WHERE id = ?", (occupation_id,)).fetchone()
    if occ is None:
        db.close()
        return jsonify({"error": "Not found"}), 404
    books = [dict(r) for r in db.execute(sql, params).fetchall()]
    db.close()
    return jsonify({"occupation": dict(occ), "books": books})


# ================================================================
# 管理画面
# ================================================================
@app.route("/admin")
def admin():
    return render_template("admin.html")


@app.route("/api/admin/lookup")
def admin_lookup():
    isbn = request.args.get("isbn", "").strip()
    if not isbn:
        return jsonify({"error": "ISBN を入力してください"}), 400
    info, err = lookup_ndl(isbn)
    if err:
        return jsonify({"error": err}), 404
    return jsonify(info)


@app.route("/api/admin/books")
def admin_books():
    db   = get_db()
    rows = db.execute("SELECT * FROM books ORDER BY id DESC").fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


# すべての NDL フィールドを受け取って INSERT する
_BOOK_FIELDS = [
    "ndl_bib_id", "ndl_uri", "isbn", "issn",
    "title", "title_kana", "parallel_title", "series_title", "edition", "volume",
    "responsibility", "author", "publisher", "pub_place", "pub_date", "year", "extent",
    "ndc", "ndlc", "subject", "genre_form", "call_number",
    "notes", "language", "material_type", "material_form", "access_url",
    "genre", "available", "thumbnail_url",
]


@app.route("/api/admin/books", methods=["POST"])
def admin_add_book():
    data = request.get_json(silent=True) or {}
    if not data.get("title"):
        return jsonify({"error": "タイトルは必須です"}), 400
    if not data.get("genre"):
        return jsonify({"error": "ジャンル（蔵書管理用）は必須です"}), 400
    if not data.get("isbn"):
        return jsonify({"error": "ISBN は必須です"}), 400

    cols   = [f for f in _BOOK_FIELDS if f in data]
    vals   = [data[f] for f in cols]
    # available のデフォルト
    if "available" not in cols:
        cols.append("available")
        vals.append(1)

    placeholders = ", ".join("?" * len(cols))
    col_names    = ", ".join(cols)

    db = get_db()
    try:
        db.execute(
            f"INSERT INTO books ({col_names}) VALUES ({placeholders})", vals)
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "この ISBN はすでに登録されています"}), 409

    book = db.execute("SELECT * FROM books WHERE isbn = ?", (data["isbn"],)).fetchone()
    db.close()
    return jsonify(dict(book)), 201


@app.route("/api/admin/books/<int:book_id>", methods=["PUT"])
def admin_update_book(book_id):
    data = request.get_json(silent=True) or {}
    if not data:
        return jsonify({"error": "更新データがありません"}), 400

    allowed = set(_BOOK_FIELDS) - {"isbn", "registered_at"}   # ISBN・登録日は変更不可
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "更新できるフィールドがありません"}), 400

    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals       = list(updates.values()) + [book_id]

    db = get_db()
    db.execute(f"UPDATE books SET {set_clause} WHERE id = ?", vals)
    db.commit()
    book = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    db.close()
    if book is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(book))


@app.route("/api/admin/books/<int:book_id>", methods=["DELETE"])
def admin_delete_book(book_id):
    db = get_db()
    db.execute(
        "DELETE FROM occupation_books WHERE isbn = (SELECT isbn FROM books WHERE id = ?)",
        (book_id,))
    db.execute("DELETE FROM books WHERE id = ?", (book_id,))
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.route("/api/admin/books/<int:book_id>/available", methods=["PUT"])
def admin_toggle_available(book_id):
    db = get_db()
    db.execute("UPDATE books SET available = 1 - available WHERE id = ?", (book_id,))
    db.commit()
    book = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    db.close()
    if book is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(book))


# ================================================================
# 職業マスタ 管理
# ================================================================
@app.route("/api/admin/occupations")
def admin_list_occupations():
    db = get_db()
    rows = db.execute("""
        SELECT o.id, o.name, o.description, o.icon,
               COUNT(ob.id) AS book_count
        FROM occupations o
        LEFT JOIN occupation_books ob ON ob.occupation_id = o.id
        GROUP BY o.id ORDER BY o.id
    """).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/occupations", methods=["POST"])
def admin_add_occupation():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "職業名は必須です"}), 400
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO occupations (name, description, icon) VALUES (?, ?, ?)",
            (name, (data.get("description") or "").strip(), (data.get("icon") or "").strip()))
        occ_id = cur.lastrowid
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "同じ名前の職業がすでに存在します"}), 409
    row = db.execute("SELECT o.id, o.name, o.description, o.icon, 0 AS book_count FROM occupations o WHERE o.id = ?", (occ_id,)).fetchone()
    db.close()
    return jsonify(dict(row)), 201


@app.route("/api/admin/occupations/<int:occ_id>", methods=["PUT"])
def admin_update_occupation(occ_id):
    data = request.get_json(silent=True) or {}
    allowed = {"name", "description", "icon"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "更新できるフィールドがありません"}), 400
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [occ_id]
    db = get_db()
    try:
        db.execute(f"UPDATE occupations SET {set_clause} WHERE id = ?", vals)
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "同じ名前の職業がすでに存在します"}), 409
    row = db.execute("""
        SELECT o.id, o.name, o.description, o.icon, COUNT(ob.id) AS book_count
        FROM occupations o LEFT JOIN occupation_books ob ON ob.occupation_id = o.id
        WHERE o.id = ? GROUP BY o.id
    """, (occ_id,)).fetchone()
    db.close()
    if row is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(row))


# ================================================================
# 職業別おすすめ 管理
# ================================================================
@app.route("/api/admin/occupation-books")
def admin_list_occ_books():
    db = get_db()
    rows = db.execute("""
        SELECT ob.id, o.name AS occupation_name, o.icon AS occupation_icon,
               b.isbn, b.title, b.author, b.thumbnail_url, ob.note
        FROM occupation_books ob
        JOIN occupations o ON o.id = ob.occupation_id
        JOIN books b ON b.isbn = ob.isbn
        ORDER BY o.name, b.title
    """).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/occupation-books", methods=["POST"])
def admin_add_occ_book():
    data     = request.get_json(silent=True) or {}
    isbn     = (data.get("isbn") or "").strip()
    occ_name = (data.get("occupation_name") or "").strip()
    note     = (data.get("note") or "").strip()

    if not isbn:
        return jsonify({"error": "ISBN は必須です"}), 400
    if not occ_name:
        return jsonify({"error": "職業名は必須です"}), 400

    db = get_db()
    book = db.execute("SELECT id FROM books WHERE isbn = ?", (isbn,)).fetchone()
    if book is None:
        db.close()
        return jsonify({"error": f"ISBN {isbn} の書籍が登録されていません"}), 404

    occ = db.execute("SELECT id FROM occupations WHERE name = ?", (occ_name,)).fetchone()
    if occ is None:
        cur    = db.execute(
            "INSERT INTO occupations (name, description, icon) VALUES (?, '', '')",
            (occ_name,))
        occ_id = cur.lastrowid
    else:
        occ_id = occ["id"]

    try:
        cur     = db.execute(
            "INSERT INTO occupation_books (occupation_id, isbn, note) VALUES (?, ?, ?)",
            (occ_id, isbn, note))
        link_id = cur.lastrowid
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "この組み合わせはすでに登録されています"}), 409

    row = db.execute("""
        SELECT ob.id, o.name AS occupation_name, o.icon AS occupation_icon,
               b.isbn, b.title, b.author, b.thumbnail_url, ob.note
        FROM occupation_books ob
        JOIN occupations o ON o.id = ob.occupation_id
        JOIN books b ON b.isbn = ob.isbn
        WHERE ob.id = ?
    """, (link_id,)).fetchone()
    db.close()
    return jsonify(dict(row)), 201


@app.route("/api/admin/occupation-books/<int:link_id>", methods=["DELETE"])
def admin_delete_occ_book(link_id):
    db = get_db()
    db.execute("DELETE FROM occupation_books WHERE id = ?", (link_id,))
    db.commit()
    db.close()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True)
