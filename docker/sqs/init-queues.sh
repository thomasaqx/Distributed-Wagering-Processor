#!/bin/sh
# Creates the SQS queues used by the service. Idempotent: CreateQueue with the
# same attributes returns the existing queue, so re-running `docker compose up` is safe.
set -eu

MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

echo "Waiting for SQS endpoint at ${AWS_ENDPOINT_URL}..."
attempt=0
until aws sqs list-queues >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "SQS endpoint not reachable after ${attempt} attempts" >&2
    exit 1
  fi
  sleep 1
done

aws sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true >/dev/null

dlq_url=$(aws sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
dlq_arn=$(aws sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# RedrivePolicy is a JSON string nested inside the attributes JSON, hence the escaping.
cat > /tmp/wager-transactions-attributes.json <<EOF
{
  "FifoQueue": "true",
  "VisibilityTimeout": "${VISIBILITY_TIMEOUT}",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
EOF

aws sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions-attributes.json >/dev/null

aws sqs create-queue --queue-name wallet-events >/dev/null

echo "Queues ready:"
aws sqs list-queues --query QueueUrls --output text | tr '\t' '\n'
