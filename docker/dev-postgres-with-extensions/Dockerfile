FROM postgres:15

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libpq-dev \
    postgresql-server-dev-15 \
    postgresql-15-cron

# Install HypoPG
RUN git clone https://github.com/HypoPG/hypopg.git /hypopg
RUN cd /hypopg && make install

# Install index_advisor
RUN git clone https://github.com/supabase/index_advisor.git /index_advisor
RUN cd /index_advisor && make install

# Write initialization SQL
RUN echo "CREATE EXTENSION pg_stat_statements;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "CREATE EXTENSION pg_cron;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "CREATE EXTENSION hypopg;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "CREATE EXTENSION index_advisor;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "CREATE ROLE anon;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "CREATE ROLE authenticated;" >> /docker-entrypoint-initdb.d/init.sql

# Create a read-only user for read replica emulation in development
RUN echo "CREATE USER readonly WITH PASSWORD 'PASSWORD-PLACEHOLDER--readonlyuqfEC1hmmv';" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "GRANT CONNECT ON DATABASE stackframe TO readonly;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "GRANT USAGE ON SCHEMA public TO readonly;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;" >> /docker-entrypoint-initdb.d/init.sql
RUN echo "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;" >> /docker-entrypoint-initdb.d/init.sql

# Create a replication user for streaming replication to the replica
RUN echo "CREATE USER replicator WITH REPLICATION PASSWORD 'PASSWORD-PLACEHOLDER--replicatorpass';" >> /docker-entrypoint-initdb.d/init.sql

# Create a script to add replication permissions to pg_hba.conf after init
# This script runs after the database is initialized but before it starts accepting connections
RUN echo '#!/bin/bash' > /docker-entrypoint-initdb.d/00-setup-replication.sh && \
    echo 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"' >> /docker-entrypoint-initdb.d/00-setup-replication.sh && \
    chmod +x /docker-entrypoint-initdb.d/00-setup-replication.sh

# Add args to Postgres entrypoint
ENTRYPOINT ["sh", "-c", "\
  # Add delay if POSTGRES_DELAY_MS is set \
  if [ $POSTGRES_DELAY_MS -gt 0 ]; then \
    apt-get update && apt-get install -y iproute2 && tc qdisc add dev eth0 root netem delay ${POSTGRES_DELAY_MS}ms; \
  fi; \
  \
  # Start Postgres with replication enabled and extensions \
  exec docker-entrypoint.sh postgres \
    -c shared_preload_libraries='pg_stat_statements,pg_cron' \
    -c cron.database_name='stackframe' \
    -c pg_stat_statements.track=all \
    -c pg_stat_statements.max=20000 \
    -c logging_collector=on \
    -c log_destination='stderr' \
    -c log_min_messages=log \
    -c log_directory='log' \
    -c log_filename='postgresql-%Y-%m-%d_%H%M%S.log' \
    -c wal_level=logical \
    -c max_wal_senders=5 \
    -c max_replication_slots=5 \
    -c wal_keep_size=64MB \
    -c hot_standby=on \
    -c statement_timeout=30s `# In production this is higher, but better safe than sorry during dev` \
"]
