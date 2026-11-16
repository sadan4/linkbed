#!/usr/bin/env python3
"""remote guest command through pinned chrysalis ssh; never prints stdin."""
import os
from pathlib import Path
import subprocess
import sys

command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
           "-o", "UserKnownHostsFile=" + str(Path.home() / ".config/lembed/known_hosts"),
           "-o", "ConnectTimeout=10",
           "-o", "ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ControlPath=/tmp/lembed-%r-%h-%p -W %h:%p root@chrysalis",
           "ops@10.203.0.50", *sys.argv[1:]]
os.execvp(command[0], command)
