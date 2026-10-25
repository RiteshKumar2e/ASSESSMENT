# How to run

Two ways to run the app: **Docker** (one command) or **local dev** (two terminals).

Prerequisites:
- Docker Desktop for option 1
- Python 3.10+ and Node 20+ for option 2

---

## Option 1: Docker

```bash
cd backend
docker compose up --build
```

Open:
- App: http://localhost:8001
- API docs: http://localhost:8001/docs

Stop it with `Ctrl+C`, or `docker compose down`.

Without compose:

```bash
cd backend
docker build -f Dockerfile -t wind-forecast-monitor ..
docker run -p 8001:8001 wind-forecast-monitor
```

---

## Option 2: Local development

### Terminal 1: backend (FastAPI on :8001)

**Windows (PowerShell)**
```powershell
cd backend
python -m venv .venv            # if "No module named venv": pip install virtualenv; python -m virtualenv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
copy .env.example .env          # optional: every setting has a default
uvicorn app.main:app --reload --port 8001
```

**macOS / Linux**
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # optional
uvicorn app.main:app --reload --port 8001
```

Check it is up: http://localhost:8001/api/health should return `{"status":"ok",...}`.

### Terminal 2: frontend (Vite on :5173)

```bash
cd frontend
copy .env.example .env          # macOS/Linux: cp .env.example .env (optional)
npm install
npm run dev
```

Open http://localhost:5173. Vite forwards `/api` requests to the backend on port 8001.

---

## Production-style run without Docker

Build the frontend and let FastAPI serve it from `backend/static`:

```bash
cd frontend
npm install
npm run build
cp -r dist ../backend/static        # Windows: xcopy /E /I dist ..\backend\static

cd ../backend
uvicorn app.main:app --port 8001    # app at http://localhost:8001
```

---

## Tests and lint

```bash
cd backend
pytest -q
ruff check .
ruff format --check .

cd ../frontend
npm run build      # TypeScript typecheck, then the Vite build
```

---

## Refresh the data (optional)

The app ships with `backend/data/snapshot.json`, so it runs without internet access. To re-download it from Elexon (no API key needed):

```bash
cd backend
python -m app.snapshot
```

---

## Frontend and backend on different hosts

Build the frontend with the backend's URL:

```bash
cd frontend
# set VITE_API_BASE_URL=https://your-backend-url in frontend/.env, then:
npm run build
```

CORS is already open for `GET` requests.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `address already in use` on port 8001 | Another app is using port 8001. Stop it, or pick another port: `uvicorn app.main:app --port 8002`, change `"8001:8001"` to `"8002:8001"` in `docker-compose.yml`, and change the proxy target in `frontend/vite.config.ts`. |
| `No module named venv` (Windows) | `pip install virtualenv`, then `python -m virtualenv .venv` |
| Frontend shows "Failed to fetch" / 500 / 502 | The backend is not running on port 8001, or `VITE_PROXY_TARGET` in `frontend/.env` points elsewhere. Use `127.0.0.1`, not `localhost`. |
| `ModuleNotFoundError: app` | Run `uvicorn` from inside the `backend/` folder. |
| Times look one hour off | They shouldn't: all times are shown in UK time (`Europe/London`). In January, UK time is the same as UTC. |
