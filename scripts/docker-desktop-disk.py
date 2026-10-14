#!/usr/bin/env python3
"""只扩展现有 Docker Desktop 磁盘容量，保留全部资源。"""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'Docker 命令失败：{args[0]}，退出码 {result.returncode}')
    return result.stdout.strip()


def read_settings(path, target):
    if path.is_symlink():
        raise ValueError('设置文件不能是符号链接')
    data = json.loads(path.read_text())
    current = data.get('DiskSizeMiB')
    if type(current) is not int or current <= 0:
        raise ValueError('现有 DiskSizeMiB 缺失或非法')
    if type(target) is not int or target % 1024 or target < current:
        raise ValueError('容量必须为整 GiB，且禁止缩小现有虚拟盘')
    return data, current


def extend_settings(path, target, expected, backup_dir):
    data, current = read_settings(path, target)
    if data != expected:
        raise RuntimeError('停止期间设置已变化，未覆盖并发修改')
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = backup_dir / f'docker-desktop-settings-{stamp}.json'
    shutil.copy2(path, backup)
    backup.chmod(0o600)
    data['DiskSizeMiB'] = target
    fd, tmp_name = tempfile.mkstemp(prefix='.docker-capacity-', dir=path.parent)
    try:
        os.fchmod(fd, path.stat().st_mode & 0o777)
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
    print(f'容量配置：{current} → {target} MiB；备份：{backup}')


def inventory():
    return {
        'images': sorted(set(docker('image', 'ls', '-aq', '--no-trunc').splitlines())),
        'containers': sorted(docker('container', 'ls', '-aq', '--no-trunc').splitlines()),
        'volumes': sorted(docker('volume', 'ls', '--format', '{{.Name}}').splitlines()),
    }


def main():
    if len(sys.argv) != 3 or sys.argv[1] != 'extend' or not sys.argv[2].isdigit():
        raise ValueError('用法：python3 scripts/docker-desktop-disk.py extend <容量MiB>')
    target = int(sys.argv[2])
    infra = Path(__file__).resolve().parent.parent
    settings = Path.home() / 'Library/Group Containers/group.com.docker/settings-store.json'
    raw = Path.home() / 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw'
    expected, current = read_settings(settings, target)
    if target == current:
        print('容量已经符合目标，无需停止 Docker Desktop。')
        return
    if os.environ.get('DOCKER_HOST') or os.environ.get('BUILDX_BUILDER'):
        raise ValueError('移除 DOCKER_HOST/BUILDX_BUILDER 后再扩展本地 Desktop')
    if docker('context', 'show') != 'desktop-linux':
        raise ValueError('只允许当前本地 desktop-linux context')
    endpoint = docker('context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}')
    if not endpoint.startswith('unix://'):
        raise ValueError('只支持本地 Unix socket')
    checksum = subprocess.run(['cksum'], input=endpoint, text=True, capture_output=True, check=True).stdout.split()[0]
    lock = Path(tempfile.gettempdir()) / f'thesis-ledger-update-{os.getuid()}-{checksum}.lock'
    lock.mkdir()  # 与正式更新共用锁；既有锁即失败，不清理他人的锁。
    try:
        (lock / 'pid').write_text(str(os.getpid()) + '\n')
        statuses = docker('buildx', '--builder', 'desktop-linux', 'history', 'ls', '--format', '{{.Status}}')
        if re.search(r'running|pending', statuses, re.I):
            raise RuntimeError('存在活动构建，未停止 Docker Desktop')
        before = inventory()
        original_inode = raw.stat().st_ino
        docker('desktop', 'stop', '--timeout', '45')
        try:
            extend_settings(settings, target, expected, infra / '.maintenance-backups/docker-desktop')
        finally:
            docker('desktop', 'start', '--timeout', '45')
        docker('info')
        if raw.stat().st_ino != original_inode or raw.stat().st_size < target * 1024 ** 2:
            raise RuntimeError('虚拟盘身份或容量未通过检查；禁止自动缩盘')
        if inventory() != before:
            raise RuntimeError('资源清单变化，保留证据并停止后续部署')
        print(f'扩展验收通过：虚拟盘 {target // 1024} GiB；镜像、容器、卷全部保留。')
    finally:
        (lock / 'pid').unlink(missing_ok=True)
        lock.rmdir()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
