#!/bin/bash
set -e

# Detect which service to run based on environment variable
# Railway sets $PORT automatically.

if [ -d "python-service" ]; then
  cd python-service
  pip install -r requirements.txt
  exec uvicorn main:app --host 0.0.0.0 --port $PORT
fi

if [ -d "node-service" ]; then
  cd node-service
  npm install
  exec npm start
fi

if [ -d "web" ]; then
  cd web
  npm install
  npm run build
  # Serve static dist folder
  npx serve -s dist -l $PORT
fi

echo "No service directory found."
exit 1
