#!/bin/bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
exec node --tls-min-version=TLSv1.0 monitor.js
