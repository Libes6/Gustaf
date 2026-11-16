"""Runs one benchmark command and sums CPU time of the processes it started, per phase.

New processes are found by comparing `ps` before and after start, filtered by a name pattern,
so the user's running Gustaf, its WebKit and its headless Chrome are never counted.
"""
import os
import re
import subprocess
import sys
import time


def snapshot(pattern):
    out = subprocess.run(["ps", "-A", "-o", "pid=,time=,rss=,comm="], capture_output=True, text=True).stdout
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not re.search(pattern, parts[3]):
            continue
        procs[int(parts[0])] = (parse_time(parts[1]), int(parts[2]))
    return procs


def parse_time(value):
    # macOS ps prints [hh:]mm:ss.ss
    seconds = 0.0
    for part in value.split(":"):
        seconds = seconds * 60 + float(part)
    return seconds


def main():
    pattern, *command = sys.argv[1:]
    before = set(snapshot(pattern))
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=os.environ)
    ours = set()
    marks = {}
    for line in proc.stdout:
        line = line.rstrip()
        if not line.startswith("[spike]"):
            continue
        fields = line.split()
        if fields[1] == "frames":
            print(line)
            continue
        current = snapshot(pattern)
        ours |= {pid for pid in current if pid not in before}
        ours.add(proc.pid)
        cpu = sum(current[pid][0] for pid in ours if pid in current)
        rss = sum(current[pid][1] for pid in ours if pid in current)
        marks[fields[1]] = (time.time(), cpu, rss)
    proc.wait()
    for phase in ("idle", "scroll"):
        start, end = marks.get(f"{phase}-start"), marks.get(f"{phase}-end")
        if not start or not end:
            continue
        wall = end[0] - start[0]
        print(f"{phase}: CPU {100 * (end[1] - start[1]) / wall:.0f}% of one core, RSS {end[2] / 1024:.0f} MB, {len(ours)} processes")


main()
