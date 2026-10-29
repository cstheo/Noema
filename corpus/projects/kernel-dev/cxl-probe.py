"""Realize a paused CXL topology without opening existing guest resources."""

import json
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="noema-cxl-probe-") as directory:
    temporary = Path(directory)
    for name, size in [("cxl.raw", 256 * 1024 * 1024), ("lsa.raw", 1024 * 1024)]:
        with (temporary / name).open("wb") as file:
            file.truncate(size)
    command = [
        "qemu-system-x86_64", "-no-user-config", "-nodefaults",
        "-machine", "q35,cxl=on,cxl-fmw.0.targets.0=cxl.0,cxl-fmw.0.size=256M",
        "-accel", "tcg", "-cpu", "max", "-smp", "1", "-m", "512M,slots=2,maxmem=2G",
        "-object", f"memory-backend-file,id=cxlmem,share=on,mem-path={temporary}/cxl.raw,size=256M",
        "-object", f"memory-backend-file,id=lsamem,share=on,mem-path={temporary}/lsa.raw,size=1M",
        "-device", "pxb-cxl,id=cxl.0,bus=pcie.0,bus_nr=12",
        "-device", "cxl-rp,id=rp0,bus=cxl.0,chassis=0,port=0,slot=0",
        "-device", "cxl-type3,id=ct3,bus=rp0,persistent-memdev=cxlmem,lsa=lsamem",
        "-S", "-display", "none", "-monitor", "none", "-serial", "none", "-qmp", "stdio",
    ]
    requests = [
        {"execute": "qmp_capabilities"},
        {"execute": "query-status"},
        {"execute": "human-monitor-command", "arguments": {"command-line": "info qtree"}},
        {"execute": "quit"},
    ]
    result = subprocess.run(
        command, input="".join(json.dumps(request) + "\n" for request in requests),
        text=True, capture_output=True, timeout=25,
    )
    messages = []
    for line in result.stdout.splitlines():
        try:
            messages.append(json.loads(line))
        except ValueError:
            pass
    tree = next((message["return"] for message in messages if isinstance(message.get("return"), str)), "")
    errors = [message["error"] for message in messages if "error" in message]
    devices = {name: name in tree for name in ["pxb-cxl", "cxl-rp", "cxl-type3"]}
    print(json.dumps({
        "qemu_version": subprocess.check_output(["qemu-system-x86_64", "--version"], text=True).splitlines()[0],
        "exit_code": result.returncode,
        "qmp_errors": errors,
        "status": [message["return"] for message in messages if isinstance(message.get("return"), dict) and "status" in message["return"]],
        "realized_devices": devices,
        "stderr": result.stderr,
        "boundary": "Paused topology realization only; no guest kernel, rootfs, repository disk, or PMEM image opened.",
    }, indent=2))
    if result.returncode or errors or not all(devices.values()):
        raise SystemExit(1)
