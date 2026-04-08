import sqlite3
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)
DB_PATH = "library.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.route("/")
def index():
    db = get_db()
    genres = [row["genre"] for row in db.execute("SELECT DISTINCT genre FROM books ORDER BY genre").fetchall()]
    db.close()
    return render_template("index.html", genres=genres)


@app.route("/api/search")
def search():
    query = request.args.get("q", "").strip()
    genre = request.args.get("genre", "").strip()
    available_only = request.args.get("available_only", "") == "1"

    sql = "SELECT * FROM books WHERE 1=1"
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

    db = get_db()
    rows = db.execute(sql, params).fetchall()
    db.close()

    books = [dict(row) for row in rows]
    return jsonify(books)


@app.route("/api/book/<int:book_id>")
def book_detail(book_id):
    db = get_db()
    book = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    db.close()
    if book is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(dict(book))


if __name__ == "__main__":
    app.run(debug=True)
