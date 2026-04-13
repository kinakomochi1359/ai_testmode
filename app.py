import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)
DB_PATH = "library.db"

# ---- 国立国会図書館 API ----------------------------------------
NDL_SRU_URL       = "https://ndlsearch.ndl.go.jp/api/sru"
NDL_THUMBNAIL_URL = "https://ndlsearch.ndl.go.jp/thumbnail/{isbn}.jpg"

_DC  = "http://purl.org/dc/elements/1.1/"
_DCT = "http://purl.org/dc/terms/"
_SRW = "http://www.loc.gov/zing/srw/"


def _first_text(root, *clark_tags):
    """Walk the tree and return the first non-empty text for any of the given {ns}local tags."""
    for tag in clark_tags:
        for el in root.iter(tag):
            if el.text and el.text.strip():
                return el.text.strip()
    return ""


def lookup_ndl(isbn: str):
    """国立国会図書館サーチ SRU API で ISBN を照会する。
    Returns (info_dict, None) on success, (None, error_str) on failure."""
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

    num_el = root.find(f"{{{_SRW}}}numberOfRecords")
    if num_el is None or num_el.text == "0":
        return None, "該当する書籍が見つかりませんでした"

    title     = _first_text(root, f"{{{_DC}}}title")
    author    = _first_text(root, f"{{{_DC}}}creator")
    publisher = _first_text(root, f"{{{_DC}}}publisher")
    date_str  = _first_text(root, f"{{{_DCT}}}issued", f"{{{_DC}}}date")

    year_m = re.search(r"\d{4}", date_str)
    year   = int(year_m.group()) if year_m else None

    # ISBN-13 を書影 URL 用に正規化
    isbn13 = isbn_clean if len(isbn_clean) == 13 else None

    return {
        "isbn":          isbn_clean,
        "title":         title,
        "author":        author,
        "publisher":     publisher,
        "year":          year,
        "thumbnail_url": NDL_THUMBNAIL_URL.format(isbn=isbn13) if isbn13 else None,
    }, None


# ---- DB helper -----------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ---- 一般画面 -------------------------------------------------
@app.route("/")
def index():
    db = get_db()
    genres = [row["genre"] for row in db.execute(
        "SELECT DISTINCT genre FROM books ORDER BY genre").fetchall()]
    db.close()
    return render_template("index.html", genres=genres)


@app.route("/api/search")
def search():
    query        = request.args.get("q", "").strip()
    genre        = request.args.get("genre", "").strip()
    available_only = request.args.get("available_only", "") == "1"

    sql    = "SELECT * FROM books WHERE 1=1"
    params = []

    if query:
        sql += " AND (title LIKE ? OR author LIKE ? OR isbn LIKE ?)"
        like = f"%{query}%"
        params += [like, like, like]
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


# ---- 職業別 ---------------------------------------------------
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

    sql    = """SELECT b.*, ob.note
                FROM occupation_books ob
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


# ---- 管理画面 -------------------------------------------------
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


@app.route("/api/admin/books", methods=["POST"])
def admin_add_book():
    data = request.get_json(silent=True) or {}
    for field in ("isbn", "title", "author", "genre"):
        if not data.get(field):
            return jsonify({"error": f"「{field}」は必須です"}), 400

    db = get_db()
    try:
        db.execute(
            "INSERT INTO books (isbn, title, author, genre, year, available) VALUES (?,?,?,?,?,1)",
            (data["isbn"], data["title"], data["author"], data["genre"], data.get("year")),
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.close()
        return jsonify({"error": "この ISBN はすでに登録されています"}), 409

    book = db.execute("SELECT * FROM books WHERE isbn = ?", (data["isbn"],)).fetchone()
    db.close()
    return jsonify(dict(book)), 201


@app.route("/api/admin/books/<int:book_id>", methods=["DELETE"])
def admin_delete_book(book_id):
    db = get_db()
    db.execute("DELETE FROM occupation_books WHERE isbn = (SELECT isbn FROM books WHERE id = ?)", (book_id,))
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


if __name__ == "__main__":
    app.run(debug=True)
