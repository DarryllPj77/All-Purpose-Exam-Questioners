# All Purpose Exam Questioners

AI-powered exam questionnaire generator built with Flask, PostgreSQL, and OpenRouter.

## Features

- User account creation and sign-in
- AI-assisted question generation
- PostgreSQL-backed data storage
- Flask-based backend
- Simple frontend interface for creating and managing question sets

## Tech Stack

- Python
- Flask
- PostgreSQL
- HTML, CSS, JavaScript
- OpenRouter API

## Project Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/all-purpose-exam-questioners.git
cd all-purpose-exam-questioners
```

### 2. Create and activate a virtual environment

```bash
python -m venv venv
```

Windows:

```bash
venv\Scripts\activate
```

macOS/Linux:

```bash
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

If you do not have a `requirements.txt` yet, install your current project dependencies manually first, then generate one with:

```bash
pip freeze > requirements.txt
```

### 4. Create your environment file

Copy `.env.example` to `.env` and fill in the real values:

```bash
cp .env.example .env
```

If you are on Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Required variables:

- `OPENROUTER_API_KEY`
- `POSTGRES_DSN`
- `FLASK_SECRET_KEY`

Example:

```env
OPENROUTER_API_KEY=your_openrouter_key
POSTGRES_DSN=postgresql://apeq:apeq@localhost:5432/apeq
FLASK_SECRET_KEY=your_long_random_secret
```

### 5. Create the PostgreSQL database

Create a PostgreSQL database and user that match your DSN.

Example:

- Database: `apeq`
- User: `apeq`
- Password: `apeq`

Example DSN:

```env
POSTGRES_DSN=postgresql://apeq:apeq@localhost:5432/apeq
```

### 6. Run the server

```bash
python server.py
```

## Environment Notes

- Commit `.env.example`, not `.env`
- Never upload real API keys or database passwords
- Rotate keys immediately if they were exposed accidentally

## GitHub Push

If this is your first push:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/all-purpose-exam-questioners.git
git push -u origin main
```

## Troubleshooting

### HTTP 405 on Create Account

A 405 error usually means the frontend is sending the wrong HTTP method or calling the wrong route, or the Flask backend route does not allow `POST`. Check that your frontend request path exactly matches the Flask auth route and that the route explicitly allows `methods=["POST"]`. [web:283][web:289]

## License

Add your preferred license here.