import os
import tempfile
import unittest
from pathlib import Path

from scripts.local_env import load_project_env


class LocalEnvTests(unittest.TestCase):
    def test_loads_values_without_overriding_existing_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env.local"
            env_file.write_text("EG2_TEST_QUOTED='local value'\nEG2_TEST_EXISTING=file\nEG2_TEST_COMMENT=value # comment\n")
            os.environ["EG2_TEST_EXISTING"] = "shell"
            try:
                load_project_env(env_file)
                self.assertEqual(os.environ["EG2_TEST_QUOTED"], "local value")
                self.assertEqual(os.environ["EG2_TEST_EXISTING"], "shell")
                self.assertEqual(os.environ["EG2_TEST_COMMENT"], "value")
            finally:
                os.environ.pop("EG2_TEST_QUOTED", None)
                os.environ.pop("EG2_TEST_EXISTING", None)
                os.environ.pop("EG2_TEST_COMMENT", None)


if __name__ == "__main__":
    unittest.main()
