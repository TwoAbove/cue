#!/bin/bash
set -e

echo "Starting E2E tests..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo "Error: Docker is not running. Please start Docker and try again."
  exit 1
fi

# Start PostgreSQL via Docker Compose
echo "Starting PostgreSQL..."
docker-compose up -d postgres

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
sleep 5

# Wait until PostgreSQL is accepting connections
until docker-compose exec postgres pg_isready -U postgres -d cue_test; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done

# Run the E2E tests
echo "Running E2E tests..."
E2E=true POSTGRES_URL="postgresql://postgres:postgres@localhost:5433/cue_test" bunx vitest test/e2e/postgres.persistence.e2e.test.ts --run

# Clean up
echo "Stopping PostgreSQL..."
docker-compose down

echo "E2E tests completed!"
