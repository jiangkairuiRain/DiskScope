import os
import json
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

_lock = threading.RLock()
_tasks = {}          # task_id -> ScanTask
_trees = {}          # root_path -> root_node
_path_map = {}       # normpath -> node

# 盘符预扫描状态
_drive_tasks = {}    # drive_path -> task_id


class ScanTask:
    def __init__(self, task_id, root_path):
        self.id = task_id
        self.root_path = root_path
        self.progress = -1          # -1 表示不确定进度
        self.current_path = ''
        self.processed_files = 0
        self.done = False
        self.error = None


def start_scan(root_path):
    """启动一个后台线程扫描 root_path，返回 task_id。"""
    task_id = str(uuid.uuid4())
    task = ScanTask(task_id, root_path)
    with _lock:
        _tasks[task_id] = task
    t = threading.Thread(target=_scan_thread, args=(root_path, task_id), daemon=True)
    t.start()
    return task_id


def get_progress(task_id):
    with _lock:
        task = _tasks.get(task_id)
        if not task:
            return None
        return {
            'progress': task.progress,
            'current': task.current_path,
            'processed_files': task.processed_files,
            'done': task.done,
            'error': task.error
        }


def get_node(path):
    norm = os.path.normpath(path)
    with _lock:
        return _path_map.get(norm)


def _scan_dir_local(path, progress_callback):
    """递归扫描一个目录树，返回节点。IO 密集，会释放 GIL。"""
    node = {
        'name': os.path.basename(path) or path,
        'path': path,
        'type': 'dir',
        'children': [],
        'size': 0,
        'has_children': False
    }
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_file():
                        size = entry.stat().st_size
                        node['children'].append({
                            'name': entry.name,
                            'path': entry.path,
                            'type': 'file',
                            'size': size,
                            'has_children': False
                        })
                        progress_callback(entry.path)
                    elif entry.is_dir():
                        sub_node = _scan_dir_local(entry.path, progress_callback)
                        if sub_node is not None:
                            node['children'].append(sub_node)
                except (PermissionError, OSError):
                    continue
    except (PermissionError, OSError):
        return None

    node['size'] = sum(c['size'] for c in node['children'])
    node['has_children'] = len(node['children']) > 0
    return node


def _scan_thread(root_path, task_id):
    """单线程递归扫描整盘（IO 密集，受 GIL 友好，不会线程爆炸）。"""
    task = _tasks.get(task_id)
    try:
        first_level_dirs = []
        first_level_files = []
        try:
            with os.scandir(root_path) as it:
                for entry in it:
                    try:
                        if entry.is_dir():
                            first_level_dirs.append(entry.path)
                        elif entry.is_file():
                            size = entry.stat().st_size
                            first_level_files.append({
                                'name': entry.name, 'path': entry.path,
                                'type': 'file', 'size': size, 'has_children': False
                            })
                    except (PermissionError, OSError):
                        continue
        except (PermissionError, OSError):
            pass

        root_node = {
            'name': os.path.basename(root_path) or root_path,
            'path': root_path, 'type': 'dir',
            'children': [], 'size': 0, 'has_children': False
        }

        def progress_cb(current):
            with _lock:
                task.processed_files += 1
                task.current_path = current

        for f_node in first_level_files:
            root_node['children'].append(f_node)
            progress_cb(f_node['path'])

        # 一级子目录用受控线程池并行（限流，避免线程爆炸）
        max_workers = min(4, os.cpu_count() or 2)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(_scan_dir_local, d, progress_cb): d
                       for d in first_level_dirs}
            for future in as_completed(futures):
                sub = future.result()
                if sub is not None:
                    root_node['children'].append(sub)

        root_node['size'] = sum(c['size'] for c in root_node['children'])
        root_node['has_children'] = len(root_node['children']) > 0

        register_tree(root_node)
        with _lock:
            _trees[root_path] = root_node
            task.done = True
            task.progress = 100
    except Exception as e:
        with _lock:
            task.error = str(e)
            task.done = True


def register_tree(node):
    with _lock:
        norm = os.path.normpath(node['path'])
        _path_map[norm] = node
        if node.get('type') == 'dir' and norm not in _trees:
            _trees[norm] = node
    if node.get('type') == 'dir':
        for child in node['children']:
            register_tree(child)


# ---------- 盘符预扫描相关 ----------
def start_drive_scan(drive_path):
    """为指定盘符启动扫描（不重复启动），返回 task_id。"""
    norm_path = os.path.normpath(drive_path)
    with _lock:
        if norm_path in _drive_tasks:
            return _drive_tasks[norm_path]
        task_id = start_scan(drive_path)
        _drive_tasks[norm_path] = task_id
        return task_id


def get_drive_scan_status(drive_path):
    norm_path = os.path.normpath(drive_path)
    with _lock:
        if norm_path not in _drive_tasks:
            return 'pending'
        task_id = _drive_tasks[norm_path]
        task = _tasks.get(task_id)
        if not task or not task.done:
            return 'scanning'
        return 'done'


def get_drive_task_id(drive_path):
    norm_path = os.path.normpath(drive_path)
    with _lock:
        return _drive_tasks.get(norm_path)


def load_or_scan_drive(drive_path):
    """每次启动都重新扫描该盘符，返回 ('scanning', task_id)。"""
    norm_path = os.path.normpath(drive_path)
    task_id = start_drive_scan(norm_path)
    return 'scanning', task_id


def prefetch_all_drives():
    """启动即对所有盘符重新扫描（每次打开程序都会重扫）。
    最多 2 个盘同时扫描，避免资源耗尽；非阻塞（后台线程）。"""
    import psutil
    drives = [p.mountpoint for p in psutil.disk_partitions()]
    # 用受控线程池启动各盘扫描线程（start_scan 内部已是独立 daemon 线程）
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(load_or_scan_drive, drives))
