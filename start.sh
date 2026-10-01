#!/bin/bash
set -e

# Install Python if missing
if ! command -v python3 &> /dev/null; then
  echo "Installing Python..."
  apt-get update
  apt-get install -y python3 python3-pip
fi

# Install Node if missing
if ! command -v node &> /dev/null; then
  echo "Installing Node..."
  apt-get update
  apt-get install -y nodejs npm
fi

# Detect which service to run
if [ -d "python-service" ]; then
  cd python-service
  pip3 install -r requirements.txt
  exec python3 -m uvicorn main:app --host 0.0.0.0 --port $PORT
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
  npx serve -s dist -l $PORT
fi

echo "No service directory found."
exit 1
