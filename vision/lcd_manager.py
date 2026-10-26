import time
from config import LCD_I2C_ADDR, LCD_COLS, LCD_ROWS

class LCDDisplayManager:
    def __init__(self):
        self.lcd = None
        self.hardware_available = False
        self._init_lcd()

    def _init_lcd(self):
        try:
            from RPLCD.i2c import CharLCD
            self.lcd = CharLCD(
                i2c_expander='PCF8574',
                address=LCD_I2C_ADDR,
                port=1,
                cols=LCD_COLS,
                rows=LCD_ROWS,
                dotsize=8
            )
            self.lcd.clear()
            self.hardware_available = True
            print(f"[LCD] 20x4 I2C LCD initialized at address 0x{LCD_I2C_ADDR:X}.")
        except Exception as e:
            print(f"[LCD] Physical LCD not available ({e}). Running in Virtual / Emulated Console mode.")
            self.hardware_available = False

    def clear(self):
        if self.hardware_available and self.lcd:
            try:
                self.lcd.clear()
            except Exception:
                pass

    def display_home_screen(self, day: int, temp: float, rh: float, co2: int, o2: float, phase: str):
        """
        Renders standard 20x4 incubation status:
        Active:
          Line 1: INCUVISION: D07/21
          Line 2: T: 37.5C  RH: 58.0%
          Line 3: CO2: 3200p O2: 20.9%
          Line 4: Phase:SETTING (OK)
        Standby:
          Line 1: INCUVISION: STANDBY
          Line 2: T: 37.5C  RH: 58.0%
          Line 3: CO2: 3200p O2: 20.9%
          Line 4: Schedule: AWAITING
        """
        if phase == "STANDBY":
            line1 = "INCUVISION: STANDBY ".ljust(20)
            line2 = f"T:{temp:4.1f}C  RH:{rh:4.1f}%".ljust(20)
            line3 = f"CO2:{co2:4d}p O2:{o2:4.1f}%".ljust(20)
            line4 = "Schedule: AWAITING  ".ljust(20)
        else:
            line1 = f"INCUVISION: D{day:02d}/21".ljust(20)
            line2 = f"T:{temp:4.1f}C  RH:{rh:4.1f}%".ljust(20)
            line3 = f"CO2:{co2:4d}p O2:{o2:4.1f}%".ljust(20)
            p_str = "HATCH" if phase == "HATCHING" else "SETTING"
            line4 = f"Phase:{p_str} (OK)".ljust(20)

        self._render_4lines(line1, line2, line3, line4)

    def display_candling_progress(self, day: int, stage_text: str):
        line1 = f"** CANDLING AUDIT **".center(20)
        line2 = f"Day {day} Evaluation".center(20)
        line3 = f"{stage_text}".center(20)
        line4 = "Please wait...".center(20)
        self._render_4lines(line1, line2, line3, line4)

    def display_candling_result(self, day: int, fertile: int, total: int, rate: float):
        line1 = f"DAY {day} AUDIT DONE".center(20)
        line2 = f"Fertile: {fertile}/{total}".ljust(20)
        line3 = f"Fertility: {rate:5.1f}%".ljust(20)
        line4 = "Vision Audit Saved".center(20)
        self._render_4lines(line1, line2, line3, line4)

    def display_alarm_screen(self, alert_message: str):
        line1 = "! ! WARNING ! !".center(20)
        line2 = f"{alert_message[:20]}".center(20)
        line3 = "Check incubator!".center(20)
        line4 = "! ! CRITICAL ! !".center(20)
        self._render_4lines(line1, line2, line3, line4)

    def _render_4lines(self, l1: str, l2: str, l3: str, l4: str):
        if self.hardware_available and self.lcd:
            try:
                self.lcd.cursor_pos = (0, 0)
                self.lcd.write_string(l1[:20])
                self.lcd.cursor_pos = (1, 0)
                self.lcd.write_string(l2[:20])
                self.lcd.cursor_pos = (2, 0)
                self.lcd.write_string(l3[:20])
                self.lcd.cursor_pos = (3, 0)
                self.lcd.write_string(l4[:20])
            except Exception as e:
                print(f"[LCD] Render error: {e}")
        else:
            # Virtual output to log/terminal
            pass

lcd_display = LCDDisplayManager()
