import os
import uuid
import threading
from utils import format_size

_lock = threading.Lock()
_tasks = {}        # task_id -> ScanTask
_trees = {}        # root_path -> root_node
_path_map = {}     # normpath -> node

class ScanTask:
    def __init__(self, task_id, root_path):
        self.id = task_id
        self.root_path = root_path
        self.progress = 0
        self.current_path = ''
        self.done = False
        self.error = None

def start_scan(root_path):
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
            'done': task.done,
            'error': task.error
        }

def get_node(path):
    norm = os.path.normpath(path)
    with _lock:
        return _path_map.get(norm)

def _count_files(path):
    """递归统计文件总数（仅文件，不含目录）"""
    count = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_file():
                        count += 1
                    elif entry.is_dir():
                        count += _count_files(entry.path)
                except (PermissionError, OSError):
                    continue
    except (PermissionError, OSError):
        pass
    return count

def _scan_thread(root_path, task_id):
    task = _tasks.get(task_id)
    try:
        # 1. 统计总文件数
        task.current_path = '统计文件数量...'
        total_files = _count_files(root_path)
        task.total_files = total_files

        # 2. 构建树
        root_node = {
            'name': os.path.basename(root_path) or root_path,
            'path': root_path,
            'type': 'dir',
            'children': [],
            'size': 0,
            'has_children': False
        }

        processed = [0]  # 可变对象，供内部函数修改

        def inc_progress(current_path):
            processed[0] += 1
            task.processed = processed[0]
            task.current_path = current_path
            if total_files > 0:
                task.progress = min(100, int((processed[0] / total_files) * 100))
            else:
                task.progress = 0

        def scan_dir(path, parent_node):
            try:
                with os.scandir(path) as it:
                    for entry in it:
                        try:
                            if entry.is_file():
                                size = entry.stat().st_size
                                file_node = {
                                    'name': entry.name,
                                    'path': entry.path,
                                    'type': 'file',
                                    'size': size,
                                    'has_children': False
                                }
                                parent_node['children'].append(file_node)
                                with _lock:
                                    _path_map[os.path.normpath(entry.path)] = file_node
                                inc_progress(entry.path)

                            elif entry.is_dir():
                                dir_node = {
                                    'name': entry.name,
                                    'path': entry.path,
                                    'type': 'dir',
                                    'children': [],
                                    'size': 0,
                                    'has_children': False
                                }
                                parent_node['children'].append(dir_node)
                                scan_dir(entry.path, dir_node)
                                dir_node['size'] = sum(c['size'] for c in dir_node['children'])
                                dir_node['has_children'] = len(dir_node['children']) > 0
                                with _lock:
                                    _path_map[os.path.normpath(entry.path)] = dir_node
                        except (PermissionError, OSError):
                            continue
            except (PermissionError, OSError):
                pass

        # 执行扫描
        scan_dir(root_path, root_node)

        # 计算根目录总大小
        root_node['size'] = sum(c['size'] for c in root_node['children'])
        root_node['has_children'] = len(root_node['children']) > 0

        with _lock:
            _path_map[os.path.normpath(root_path)] = root_node
            _trees[root_path] = root_node

        task.done = True
        task.progress = 100

    except Exception as e:
        task.error = str(e)
        task.done = True