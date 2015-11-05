#!/bin/bash

set -e
# we use this data directory for the backward compatibility
# older mup uses mongodb from apt-get and they used this data directory
sudo docker pull mongo:latest
set +e
sudo docker rm -f mongodb

if [ "<%= mongoStomp %>" == true ]; then
  sudo rm -r /var/lib/mongodb/
else
  if [ "<%= mongoUnlock %>" == true ]; then
    echo "delete mongo lock"
    sudo rm -r /var/lib/mongodb/mongod.lock
  fi
fi
sudo mkdir -p /var/lib/mongodb

set -e

sudo docker run \
  -d \
  --restart=always \
  --publish=127.0.0.1:27017:27017 \
  --volume=/var/lib/mongodb:/data/db \
  --volume=/opt/mongodb/mongodb.conf:/mongodb.conf \
  --name=mongodb \
  mongo mongod -f /mongodb.conf

