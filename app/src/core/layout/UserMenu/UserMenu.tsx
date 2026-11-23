import { faGear } from '@fortawesome/free-solid-svg-icons'
import { IconButton, Dropdown } from '@cxxi-lab/hubbyware-ui'
import { type UserMenuProps } from './UserMenu.types'
import { styles } from './UserMenu.variants'
import { NotificationsMenu } from './NotificationsMenu'

export function UserMenu({ onHubbies, onDevices, onSettings, onLogout }: UserMenuProps) {
	const userHeader = (isOpen: boolean) => (
		<IconButton
			size="xl"
			shape="circle"
			color="dark"
			active={isOpen}
			icon={faGear}
			aria-label="Menu"
		/>
	)

	return (
		<ul className={styles.container()}>
			<li>
				<NotificationsMenu />
			</li>

			<li>
				<Dropdown side="right" header={userHeader} className={styles.phoneWide()}>
					<div className={styles.menu()}>
						<div className={styles.section()}>
							{onHubbies && (
								<button type="button" onClick={onHubbies} className={styles.item()}>
									Hubbies
								</button>
							)}
							{onDevices && (
								<button type="button" onClick={onDevices} className={styles.item()}>
									Devices
								</button>
							)}
							{onSettings && (
								<button type="button" onClick={onSettings} className={styles.item()}>
									Settings
								</button>
							)}
						</div>
						<div className={styles.section()}>
							{onLogout && (
								<button type="button" onClick={() => void onLogout()} className={styles.item()}>
									Log out
								</button>
							)}
						</div>
					</div>
				</Dropdown>
			</li>
		</ul>
	)
}
