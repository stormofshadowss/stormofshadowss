# The backup service for the stand-alone Unraid stack (deploy/unraid/docker-compose.yml): MariaDB's own tools plus the backup script, built from the repository itself,
# so the stack needs no files on the server. (The clone-based docker-compose.yml mounts deploy/backup.sh directly instead.)
FROM mariadb:10.11
COPY deploy/backup.sh /backup.sh
ENTRYPOINT ["/bin/sh", "/backup.sh"]
